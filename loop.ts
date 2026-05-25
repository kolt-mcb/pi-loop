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
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_ITERATIONS = 100; // safety cap so a runaway loop self-terminates
const MIN_INTERVAL_MS = 1_000;
const TURN_START_TIMEOUT_MS = 10_000; // how long to wait for a fired turn to begin streaming
const IDLE_SETTLE_MS = 200; // gap used to confirm idle across retry/compaction segments
const POLL_MS = 50;

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

export default function loopExtension(pi: ExtensionAPI) {
	// Single active loop, held in module/closure scope (so it outlives one turn
	// but is reset on session change below).
	let mode: LoopMode | null = null;
	let payload = "";
	let periodMs = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let iterations = 0;
	// Self-paced: did the agent request another iteration during the last turn?
	let rescheduled = false;
	let rescheduleDelayMs = 0;
	let wakeupToolRegistered = false;

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

	function stop(reason: string, announce = true) {
		if (!active()) return;
		clearTimer();
		mode = null;
		payload = "";
		iterations = 0;
		rescheduled = false;
		if (announce) notify(`Loop stopped (${reason}).`);
	}

	/**
	 * Wait until a fired turn has fully completed. Robust against two hazards:
	 *  - the start race: `activeRun` (and thus waitForIdle) isn't set the instant
	 *    sendUserMessage returns, so we first wait for the agent to become busy;
	 *  - retry / auto-compaction, which split one logical turn into several agent
	 *    run segments — each resolves waitForIdle and re-emits agent_end — so we
	 *    only treat the turn as done once idle *settles*.
	 */
	async function waitForTurn(ctx: ExtensionCommandContext) {
		const deadline = Date.now() + TURN_START_TIMEOUT_MS;
		while (ctx.isIdle() && Date.now() < deadline) await delay(POLL_MS);
		// If it never became busy, the payload triggered no turn; treat as done.
		for (;;) {
			await ctx.waitForIdle();
			await delay(IDLE_SETTLE_MS);
			if (ctx.isIdle()) return;
		}
	}

	function scheduleNext() {
		if (!active()) return;
		if (mode === "interval") {
			timer = setTimeout(() => void runIteration(), periodMs);
		} else if (rescheduled) {
			timer = setTimeout(() => void runIteration(), rescheduleDelayMs);
		} else {
			stop("agent did not reschedule");
		}
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
				if (mode === "self-paced") rescheduled = false;
				const text = mode === "self-paced" ? payload + SELF_PACED_HINT : payload;
				pi.sendUserMessage(text, { executeSlashCommands: true });
				await waitForTurn(ctx);
				if (!active()) return;
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
			if (/\s/.test(prefix)) return null; // past the first token — it's payload now
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

	// Never let a loop leak across a session change (closure scope outlives one
	// session). session_start at startup is a harmless no-op (no active loop).
	pi.on("session_start", () => stop("session changed", false));
	pi.on("session_shutdown", () => stop("shutdown", false));
}
