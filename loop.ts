/**
 * Loop Extension
 *
 * Runs a prompt or slash-command repeatedly, modelled on Claude Code's /loop.
 *
 * Modes:
 *   /loop 5m /run-tests     Interval: re-fire the payload every 5 minutes
 *   /loop 30s say hi        Interval with a plain prompt (s/m/h, default seconds)
 *   /loop keep fixing lint  Self-paced: the agent decides when to continue by
 *                           calling the schedule_loop_wakeup tool; the loop ends
 *                           as soon as it stops calling it.
 *   /loop stop              Stop the active loop (also: /loop off)
 *   /loop                   Show status / usage
 *
 * Notes:
 *   - Only one loop runs at a time.
 *   - Loops do NOT survive restart or a session switch.
 *   - The loop yields automatically when you type your own message.
 *   - The interval is a floor: a turn longer than the period serializes, since
 *     an iteration only fires while the agent is idle.
 *   - While a loop is active the footer shows a live countdown to the next
 *     iteration (or "running" during a turn).
 *   - Stops itself if a turn fails to start repeatedly (e.g. no model configured).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_ITERATIONS = 100; // safety cap so a runaway loop self-terminates
const MAX_NO_TURN = 3; // stop after this many consecutive iterations that start no turn
const MIN_INTERVAL_MS = 1_000;
const TURN_START_TIMEOUT_MS = 10_000; // how long to wait for a fired turn to begin streaming
const IDLE_SETTLE_MS = 200; // gap used to confirm idle across retry/compaction segments
const STATUS_KEY = "loop"; // footer status slot
const TICK_MS = 1_000; // countdown refresh interval

const SELF_PACED_HINT =
	"\n\n[Self-paced loop: call the schedule_loop_wakeup tool at the END of your turn to run this again, or omit it to end the loop.]";

type LoopMode = "interval" | "self-paced";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parse an interval token like "30s", "5m", "1h", or a bare number (seconds). */
function parseDuration(token: string): number | null {
	const match = /^(\d+)(s|m|h)?$/.exec(token.trim());
	if (!match) return null;
	const value = Number(match[1]);
	const unit = match[2] ?? "s";
	const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
	return value * multiplier;
}

/** Compact "1h05m" / "5m03s" / "12s" rendering of a remaining duration. */
function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

export default function loopExtension(pi: ExtensionAPI) {
	// Single active loop, held in module/closure scope (so it outlives one turn
	// but is reset on session change below).
	let mode: LoopMode | null = null;
	let payload = "";
	let periodMs = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let iterations = 0;
	let consecutiveNoTurns = 0; // iterations in a row that started no turn (misconfig guard)
	// Self-paced: did the agent request another iteration during the last turn?
	let rescheduled = false;
	let rescheduleDelayMs = 0;
	let wakeupToolRegistered = false;
	// Footer countdown state.
	let nextFireAt: number | null = null; // epoch ms of the next iteration, or null
	let running = false; // a turn is currently in flight
	let ticker: ReturnType<typeof setInterval> | undefined;
	// One-shot resolver for the next agent_start (set while waiting for a fired turn to begin).
	let turnStartResolver: (() => void) | null = null;

	const active = () => mode !== null;

	const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
		void pi.withCommandContext((ctx) => ctx.ui.notify(message, type));
	};

	function clearTimer() {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	}

	// --- Footer countdown -----------------------------------------------------

	function stopTicker() {
		if (ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
	}

	function renderStatus() {
		void pi.withCommandContext((ctx) => {
			if (!active()) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			if (!ctx.hasUI) {
				stopTicker(); // nothing to paint in non-interactive modes
				return;
			}
			const theme = ctx.ui.theme;
			const label = mode === "self-paced" ? "self-paced loop" : "loop";
			let body: string;
			if (running) {
				body = `running · iter ${iterations + 1}`;
			} else if (nextFireAt !== null) {
				body = `next in ${formatRemaining(nextFireAt - Date.now())} · ${iterations} done`;
			} else {
				body = `active · ${iterations} done`;
			}
			ctx.ui.setStatus(STATUS_KEY, `${theme.fg("accent", "⟳")} ${theme.fg("dim", `${label} · ${body}`)}`);
		});
	}

	function startTicker() {
		if (ticker) return;
		renderStatus(); // immediate paint, then refresh every second
		ticker = setInterval(renderStatus, TICK_MS);
		ticker.unref?.(); // purely cosmetic — never keep the process alive
	}

	function clearStatus() {
		stopTicker();
		nextFireAt = null;
		running = false;
		void pi.withCommandContext((ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));
	}

	// --- Loop control ---------------------------------------------------------

	function stop(reason: string, announce = true) {
		if (!active()) return;
		clearTimer();
		clearStatus();
		mode = null;
		payload = "";
		iterations = 0;
		consecutiveNoTurns = 0;
		rescheduled = false;
		if (announce) notify(`Loop stopped (${reason}).`);
	}

	/**
	 * Resolve when the next `agent_start` fires — i.e. the fired turn actually
	 * begins streaming. Returns `false` if it times out (payload triggered no
	 * turn), so the caller doesn't hang. Registering the resolver right after
	 * sendUserMessage is safe: control returns here before agent_start fires.
	 */
	function waitForTurnStart(): Promise<boolean> {
		return new Promise((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout>;
			const finish = (started: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (turnStartResolver === onStart) turnStartResolver = null;
				resolve(started);
			};
			const onStart = () => finish(true);
			timer = setTimeout(() => finish(false), TURN_START_TIMEOUT_MS);
			turnStartResolver = onStart;
		});
	}

	/**
	 * Wait until a fired turn has fully completed. Robust against two hazards:
	 *  - the start race: `activeRun` (and thus waitForIdle) isn't set the instant
	 *    sendUserMessage returns — so we first wait for `agent_start`;
	 *  - retry / auto-compaction, which split one logical turn into several agent
	 *    run segments — each resolves waitForIdle and re-emits agent_end — so we
	 *    only treat the turn as done once idle *settles*.
	 */
	/** @returns true if a turn ran, false if none began within the timeout. */
	async function waitForTurn(ctx: ExtensionCommandContext): Promise<boolean> {
		if (ctx.isIdle() && !(await waitForTurnStart())) return false;
		for (;;) {
			await ctx.waitForIdle();
			await delay(IDLE_SETTLE_MS);
			if (ctx.isIdle()) return true;
		}
	}

	function scheduleNext() {
		if (!active()) return;
		running = false;
		if (mode === "interval") {
			nextFireAt = Date.now() + periodMs;
			timer = setTimeout(() => void runIteration(), periodMs);
		} else if (rescheduled) {
			nextFireAt = Date.now() + rescheduleDelayMs;
			timer = setTimeout(() => void runIteration(), rescheduleDelayMs);
		} else {
			stop("agent did not reschedule");
			return;
		}
		renderStatus();
	}

	async function runIteration() {
		timer = undefined;
		if (!active()) return;
		try {
			await pi.withCommandContext(async (ctx) => {
				if (!active()) return;
				if (!ctx.isIdle()) {
					// User is mid-turn; retry shortly without consuming an iteration.
					timer = setTimeout(() => void runIteration(), 1_000);
					return;
				}
				running = true;
				nextFireAt = null;
				renderStatus();
				if (mode === "self-paced") rescheduled = false;
				const text = mode === "self-paced" ? payload + SELF_PACED_HINT : payload;
				pi.sendUserMessage(text, { executeSlashCommands: true });
				const turnRan = await waitForTurn(ctx);
				running = false;
				if (!active()) return;
				if (!turnRan) {
					// No turn started — likely a misconfigured session (no model/API key)
					// or a payload that triggers nothing. Don't spin silently.
					consecutiveNoTurns += 1;
					if (consecutiveNoTurns >= MAX_NO_TURN) {
						stop(`no turn started ${MAX_NO_TURN}× in a row — check the model/API key and prompt`);
						return;
					}
					scheduleNext();
					return;
				}
				consecutiveNoTurns = 0;
				iterations += 1;
				if (iterations >= MAX_ITERATIONS) {
					stop(`reached ${MAX_ITERATIONS}-iteration cap`);
					return;
				}
				scheduleNext();
			});
		} catch (error) {
			// Never leave a dangling timer / unhandled rejection — stop cleanly.
			stop(`error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function ensureWakeupTool() {
		if (wakeupToolRegistered) return;
		wakeupToolRegistered = true;
		pi.registerTool({
			name: "schedule_loop_wakeup",
			label: "Schedule Loop Wakeup",
			description:
				"Continue the active self-paced /loop. Call this once, at the end of your turn, to be re-invoked with the same loop prompt. If you do not call it, the loop ends.",
			promptSnippet: "Continue a self-paced /loop by requesting another iteration.",
			promptGuidelines: [
				"Only relevant while a self-paced /loop is active.",
				"Call schedule_loop_wakeup once at the end of a turn to keep looping; omit it to stop.",
			],
			parameters: Type.Object({
				reason: Type.Optional(Type.String({ description: "Why to continue (for your own tracking)." })),
				delaySeconds: Type.Optional(
					Type.Number({ description: "Optional delay in seconds before the next iteration." }),
				),
			}),
			async execute(_toolCallId, params) {
				if (mode !== "self-paced") {
					return { content: [{ type: "text", text: "No active self-paced loop; ignoring." }], details: null };
				}
				rescheduled = true;
				rescheduleDelayMs = Math.max(0, Math.round((params.delaySeconds ?? 0) * 1000));
				const when = rescheduleDelayMs ? ` in ${rescheduleDelayMs / 1000}s` : "";
				return { content: [{ type: "text", text: `Loop will continue${when}.` }], details: null };
			},
		});
	}

	pi.registerCommand("loop", {
		description: "Run a prompt or slash-command repeatedly. /loop <interval> <payload> | /loop <prompt> | /loop stop",
		// Offer the discrete sub-commands while the first token is being typed;
		// return null for anything else so freeform prompt text isn't disturbed.
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			// Only suggest stop/off when a loop is running, and only on the first token.
			if (!active() || /\s/.test(prefix)) return null;
			const items: AutocompleteItem[] = [
				{ value: "stop", label: "stop — end the active loop" },
				{ value: "off", label: "off — end the active loop" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const firstToken = trimmed.split(/\s+/)[0] ?? "";

			if (firstToken === "stop" || firstToken === "off") {
				if (!active()) {
					ctx.ui.notify("No active loop.", "info");
					return;
				}
				stop("requested", false);
				ctx.ui.notify("Loop stopped.", "info");
				return;
			}

			if (!trimmed) {
				ctx.ui.notify(
					active()
						? `Loop active (${mode}), iteration ${iterations}. Use /loop stop to end it.`
						: "Usage: /loop <interval> <payload> | /loop <prompt> | /loop stop",
					"info",
				);
				return;
			}

			if (active()) {
				ctx.ui.notify("A loop is already running. Use /loop stop first.", "warning");
				return;
			}

			const durationMs = parseDuration(firstToken);
			if (durationMs !== null) {
				const rest = trimmed.slice(firstToken.length).trim();
				if (!rest) {
					ctx.ui.notify("Usage: /loop <interval> <payload>", "warning");
					return;
				}
				mode = "interval";
				periodMs = Math.max(MIN_INTERVAL_MS, durationMs);
				payload = rest;
				iterations = 0;
				ctx.ui.notify(`Loop started: every ${periodMs / 1000}s → ${payload}`, "info");
			} else {
				ensureWakeupTool();
				mode = "self-paced";
				payload = trimmed;
				iterations = 0;
				rescheduled = false;
				ctx.ui.notify(`Self-paced loop started → ${payload}`, "info");
			}

			startTicker();
			// Kick off on the next tick so the current command dispatch fully
			// unwinds before the first iteration's prompt() begins.
			timer = setTimeout(() => void runIteration(), 0);
		},
	});

	// Yield to the user: stop when they type their own message, and let the
	// message itself continue through to the agent. Only interactive input
	// reaches here for non-command text — `/loop ...` is dispatched as a command
	// before the input event fires, and our own re-fires use source "extension".
	pi.on("input", (event, ctx) => {
		if (active() && event.source === "interactive") {
			stop("you took over", false);
			ctx.ui.notify("Loop stopped (you took over).", "info");
		}
		return { action: "continue" };
	});

	// Signal a pending waitForTurnStart() when the fired turn actually begins.
	pi.on("agent_start", () => turnStartResolver?.());

	// Never let a loop leak across a session change (closure scope outlives one
	// session). session_start at startup is a harmless no-op (no active loop).
	pi.on("session_start", () => stop("session changed", false));
	pi.on("session_shutdown", () => stop("shutdown", false));
}
