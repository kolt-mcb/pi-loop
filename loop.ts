/**
 * Loop Extension
 *
 * Runs a prompt repeatedly, modelled on Claude Code's /loop.
 * The model interprets any interval from natural language and
 * calls schedule_loop_wakeup to control cadence.
 *
 * Usage:
 *   /loop every 5 minutes check tests    — model parses interval, reschedules with delay
 *   /loop every hour deploy               — 1h interval
 *   /loop check tests                     — no interval → immediate re-fire
 *   /loop stop                            — stop the active loop
 *   /loop                                 — show status
 *
 * Notes:
 *   - Only one loop runs at a time.
 *   - Loops do NOT survive restart or a session switch.
 *   - The loop yields when the user types their own message.
 *   - The interval is a floor: turns longer than the period serialize.
 *   - Footer shows a live countdown ("next in 4m12s · iter 3 done").
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 100;   // runaway guard
const MAX_NO_TURN = 3;        // consecutive no-op iterations before giving up
const IDLE_SETTLE_MS = 200;   // settle gap across retry/compaction segments
const STATUS_KEY = "loop";
const TICK_MS = 1_000;

const SELF_PACED_HINT =
	"\n\n[Self-paced loop: call the schedule_loop_wakeup tool at the END of your turn to run this again, or omit it to end the loop.]";

// ── Helpers ────────────────────────────────────────────────────────────────

const idle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1_000));
	const h = Math.floor(total / 3_600);
	const m = Math.floor((total % 3_600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

// ── State ──────────────────────────────────────────────────────────────────

class Loop {
	api!: ExtensionAPI;

	mode: "self-paced" | null = null;
	payload = "";
	iterations = 0;
	consecutiveNoTurns = 0;

	rescheduled = false;
	rescheduleDelayMs = 0;

	timer: ReturnType<typeof setTimeout> | undefined;
	ticker: ReturnType<typeof setInterval> | undefined;
	nextFireAt: number | null = null;
	running = false;
	turnStartResolver: (() => void) | null = null;
	wakeupRegistered = false;

	get active() {
		return this.mode !== null;
	}

	clearTimer() {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	stopTicker() {
		clearInterval(this.ticker);
		this.ticker = undefined;
	}

	// ── Status bar ────────────────────────────────────────────────────────

	private renderStatus(): void {
		try {
			void this.api.withCommandContext((ctx) => {
				if (!this.active) {
					ctx.ui.setStatus(STATUS_KEY, undefined);
					return;
				}
				if (!ctx.hasUI) {
					this.stopTicker();
					return;
				}
				const theme = ctx.ui.theme;
				const body =
					this.running
						? `running · iter ${this.iterations + 1}`
						: this.nextFireAt !== null
							? `next in ${formatRemaining(this.nextFireAt - Date.now())} · ${this.iterations} done`
							: `active · ${this.iterations} done`;
				ctx.ui.setStatus(
					STATUS_KEY,
					`${theme.fg("accent", "⟳")} ${theme.fg("dim", `loop · ${body}`)}`,
				);
			});
		} catch {
			// Session may have changed; ticker will clean up
			this.stopTicker();
		}
	}

	startTicker() {
		if (this.ticker) return;
		this.renderStatus();
		this.ticker = setInterval(() => this.renderStatus(), TICK_MS);
		this.ticker.unref?.();
	}

	clearStatus() {
		this.stopTicker();
		this.nextFireAt = null;
		this.running = false;
		try {
			void this.api.withCommandContext((ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));
		} catch {
			// Session may have changed
		}
	}

	// ── Stop ──────────────────────────────────────────────────────────────

	stop(reason: string, announce = true) {
		if (!this.active) return;
		this.clearTimer();
		this.clearStatus();
		this.mode = null;
		this.payload = "";
		this.iterations = 0;
		this.consecutiveNoTurns = 0;
		this.rescheduled = false;
		try {
			if (announce) void this.api.withCommandContext((ctx) => ctx.ui.notify(`Loop stopped (${reason}).`));
		} catch {
			// Session may have changed
		}
	}

	// ── Turn waiting ──────────────────────────────────────────────────────

	private waitForTurnStart(): Promise<boolean> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (ok: boolean) => {
				if (settled) return;
				settled = true;
				if (this.turnStartResolver === handler) this.turnStartResolver = null;
				resolve(ok);
			};
			const handler = () => finish(true);
			this.turnStartResolver = handler;
			setTimeout(() => finish(false), 10_000);
		});
	}

	private async waitForTurn(ctx: ExtensionCommandContext): Promise<boolean> {
		if (ctx.isIdle() && !(await this.waitForTurnStart())) return false;
		for (;;) {
			await ctx.waitForIdle();
			await idle(IDLE_SETTLE_MS);
			if (ctx.isIdle()) return true;
		}
	}

	// ── Scheduling ────────────────────────────────────────────────────────

	scheduleNext() {
		if (!this.active) return;
		this.running = false;

		if (this.rescheduled) {
			this.nextFireAt = Date.now() + this.rescheduleDelayMs;
			this.timer = setTimeout(() => this.runIteration(), this.rescheduleDelayMs);
		} else {
			this.stop("agent did not reschedule");
			return;
		}
		this.renderStatus();
	}

	// ── Core iteration ────────────────────────────────────────────────────

	async runIteration() {
		this.clearTimer();
		if (!this.active) return;

		try {
			await this.api.withCommandContext(async (ctx) => {
				if (!this.active) return;

				if (!ctx.isIdle()) {
					this.timer = setTimeout(() => this.runIteration(), 1_000);
					return;
				}

				this.running = true;
				this.nextFireAt = null;
				this.rescheduled = false;
				this.renderStatus();

				this.api.sendUserMessage(this.payload + SELF_PACED_HINT, {
					executeSlashCommands: true,
				});

				const turnRan = await this.waitForTurn(ctx);
				this.running = false;
				if (!this.active) return;

				if (!turnRan) {
					this.consecutiveNoTurns += 1;
					if (this.consecutiveNoTurns >= MAX_NO_TURN) {
						this.stop(
							`no turn started ${MAX_NO_TURN}× in a row — check model/API key`,
						);
						return;
					}
					this.scheduleNext();
					return;
				}
				this.consecutiveNoTurns = 0;
				this.iterations += 1;

				if (this.iterations >= MAX_ITERATIONS) {
					this.stop(`reached ${MAX_ITERATIONS}-iteration cap`);
					return;
				}
				this.scheduleNext();
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.stop(`error: ${msg}`);
		}
	}

	// ── Self-paced tool ───────────────────────────────────────────────────

	private ensureWakeupTool() {
		if (this.wakeupRegistered) return;
		this.wakeupRegistered = true;

		this.api.registerTool({
			name: "schedule_loop_wakeup",
			label: "Schedule Loop Wakeup",
			description:
				"Continue the active self-paced /loop. Call this once, at the end of your turn, " +
				"to be re-invoked with the same loop prompt. If you do not call it, the loop ends.",
			promptSnippet: "Continue a self-paced /loop by requesting another iteration.",
			promptGuidelines: [
				"Only relevant while a self-paced /loop is active.",
				"Call schedule_loop_wakeup once at the end of a turn to keep looping; omit it to stop.",
			],
			parameters: Type.Object({
				reason: Type.Optional(
					Type.String({ description: "Why to continue (for your own tracking)." }),
				),
				delaySeconds: Type.Optional(
					Type.Number({ description: "Optional delay in seconds before the next iteration." }),
				),
			}),
			// Arrow fn → `this` is lexically the Loop instance, regardless of how
			// pi invokes execute() (method shorthand would rebind `this`).
			execute: async (_toolCallId, params) => {
				if (this.mode !== "self-paced") {
					return {
						content: [{ type: "text", text: "No active self-paced loop; ignoring." }],
						details: null,
					};
				}
				this.rescheduled = true;
				this.rescheduleDelayMs = Math.max(0, Math.round((params.delaySeconds ?? 0) * 1_000));
				const when = this.rescheduleDelayMs ? ` in ${this.rescheduleDelayMs / 1_000}s` : "";
				return {
					content: [{ type: "text", text: `Loop will continue${when}.` }],
					details: null,
				};
			},
		});
	}
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function loopExtension(pi: ExtensionAPI) {
	const loop = new Loop();
	loop.api = pi;

	const notify = (msg: string, type: "info" | "warning" | "error" = "info") =>
		void pi.withCommandContext((ctx) => ctx.ui.notify(msg, type));

	pi.registerCommand("loop", {
		description: "Run a prompt repeatedly. The model interprets interval from natural language.",

		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			if (!loop.active || /\s/.test(prefix)) return null;
			const items = [
				{ value: "stop", label: "stop — end the active loop" },
				{ value: "off", label: "off — end the active loop" },
			];
			const matches = items.filter((i) => i.value.startsWith(prefix));
			return matches.length > 0 ? matches : null;
		},

		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			const first = trimmed.split(/\s+/)[0] ?? "";

			// Stop
			if (first === "stop" || first === "off") {
				if (!loop.active) {
					notify("No active loop.");
					return;
				}
				loop.stop("requested", false);
				notify("Loop stopped.");
				return;
			}

			// Status
			if (!trimmed) {
				notify(
					loop.active
						? `Loop active, iteration ${loop.iterations}. Use /loop stop to end it.`
						: "Usage: /loop <prompt with interval> | /loop stop",
				);
				return;
			}

			// Already running
			if (loop.active) {
				notify("A loop is already running. Use /loop stop first.", "warning");
				return;
			}

			// Everything after /loop is the payload — the model interprets interval
			loop.ensureWakeupTool();
			loop.mode = "self-paced";
			loop.payload = trimmed;
			loop.iterations = 0;
			notify(`Loop started → ${loop.payload}`);
			loop.startTicker();
			loop.timer = setTimeout(() => loop.runIteration(), 0);
		},
	});

	// ── Lifecycle ─────────────────────────────────────────────────────────

	// User types → stop loop and yield
	pi.on("input", (event, ctx) => {
		if (loop.active && event.source === "interactive") {
			loop.stop("you took over", false);
			notify("Loop stopped (you took over).");
		}
		return { action: "continue" };
	});

	// Resolve turn-start race
	pi.on("agent_start", () => loop.turnStartResolver?.());

	// Clean stop on session change or shutdown
	pi.on("session_start", () => loop.stop("session changed", false));
	pi.on("session_shutdown", () => loop.stop("shutdown", false));
}
