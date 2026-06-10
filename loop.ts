/**
 * pi-loop — run a prompt repeatedly, Claude Code /loop style.
 *
 * Two ways to drive a loop:
 *   /loop 15m <prompt>   Fixed interval. Parsed at the command layer into a cron
 *                        schedule and run by a self-re-arming timer. Continuation
 *                        is the DEFAULT — it keeps firing until you stop it,
 *                        7 days elapse, or it hits maxFires. The model is never
 *                        responsible for keeping it alive.
 *   /loop <prompt>       Self-paced. Fires once, then only continues when the
 *                        model calls schedule_loop_wakeup (it may end the loop by
 *                        not calling it). This is the original behaviour, kept.
 *
 * The agent can also schedule cron / event / hybrid loops as background tasks via
 * the LoopCreate / LoopList / LoopDelete tools.
 *
 * Notes:
 *   - Loops persist to .pi/loops and are restored, if unexpired, on --resume.
 *     Set PI_LOOP=off for in-memory only, or PI_LOOP=<path> for a custom store.
 *   - A cron tick that lands while the agent is busy marks the loop "due" instead
 *     of queueing a stale prompt; the fire is delivered fresh as soon as the agent
 *     goes idle. Ticks landing while already due collapse into one fire, and
 *     fireCount only counts fires that were actually delivered.
 *   - Typing while a self-paced loop waits ends it (you took over). Fixed/event
 *     loops keep running across your messages until you /loop stop them.
 */

import { join, resolve } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { extractInterval, parseInterval } from "./src/loop-parse";
import { CronScheduler } from "./src/scheduler";
import { LoopStore } from "./src/store";
import { TriggerSystem } from "./src/triggers";
import type { LoopEntry, LoopFireEvent, Trigger } from "./src/types";

const STATUS_KEY = "loop";
const TICK_MS = 1000;
const DEFAULT_DEBOUNCE_MS = 30000;

// Lifecycle events bridged onto the events bus so event/hybrid loops can target
// them by name (e.g. trigger="tool_execution_end").
const BRIDGED_EVENTS = [
	"tool_execution_start",
	"tool_execution_end",
	"turn_start",
	"turn_end",
	"agent_start",
	"agent_end",
	"message_end",
] as const;

// Auto-continuing loops keep going on their own (the harness re-fires after each
// turn) — the model is NOT responsible for keeping them alive, mirroring how
// Codex/Claude Code agent loops continue by default and stop only on an explicit
// signal. The hint tells the model how to STOP, not how to continue.
const SELF_PACED_HINT =
	"\n\n[Auto-looping task: this repeats automatically after each turn. When the goal is fully achieved and nothing remains, call LoopDelete with this loop's id to stop it. To wait longer before the next iteration, call schedule_loop_wakeup with delaySeconds.]";

// Gap before a self-paced loop auto-continues after a turn ends. Small by design:
// the previous turn already did the work, so the next iteration starts promptly.
// Override per-iteration with schedule_loop_wakeup(delaySeconds), or globally with
// PI_LOOP_CONTINUE_MS.
const SELF_PACED_CONTINUE_MS = (() => {
	const raw = Number(process.env.PI_LOOP_CONTINUE_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
})();

const READONLY_NOTE =
	"\n\nREAD-ONLY MODE — use only read/inspection tools. No file writes, shell execution, or destructive changes.";

function textResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: undefined } as AgentToolResult<unknown>;
}

function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

function describeTrigger(trigger: Trigger): string {
	switch (trigger.type) {
		case "cron":
			return `cron: ${trigger.schedule}`;
		case "event":
			return `event: ${trigger.source}`;
		case "hybrid":
			return `hybrid: ${trigger.cron} + ${trigger.event.source}`;
		case "self-paced":
			return "self-paced";
	}
}

function inferTriggerType(input: string): "cron" | "event" | "hybrid" {
	if (input.includes("hybrid") || (input.includes("cron") && input.includes("event"))) return "hybrid";
	const t = input.trim();
	if (/^\d+\s*[smhd]$/i.test(t)) return "cron";
	if (t.split(/\s+/).length === 5 && /^[*\d]/.test(t)) return "cron";
	return "event";
}

export default function loopExtension(pi: ExtensionAPI) {
	const piLoopEnv = process.env.PI_LOOP;

	function resolveStorePath(sessionId?: string): string | undefined {
		if (piLoopEnv === "off") return undefined;
		if (piLoopEnv?.startsWith("/")) return piLoopEnv;
		if (piLoopEnv?.startsWith(".")) return resolve(piLoopEnv);
		if (piLoopEnv) return resolve(piLoopEnv);
		if (!sessionId) return undefined;
		return join(process.cwd(), ".pi", "loops", `loops-${sessionId}.json`);
	}

	const store = new LoopStore(resolveStorePath());

	let latestCtx: ExtensionContext | undefined;
	let latestUI: ExtensionUIContext | undefined;
	let boundSessionId: string | undefined;
	let lastSelfPacedId: string | undefined;
	const selfPacedTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Wall-clock ms a self-paced loop's next iteration will fire, so the status
	// widget can show a live countdown to the auto-continue.
	const selfPacedFireTimes = new Map<string, number>();
	// Cron loops whose tick landed mid-turn; they fire when the agent goes idle.
	const dueLoops = new Set<string>();
	let ticker: ReturnType<typeof setInterval> | undefined;

	const notify = (msg: string, type: "info" | "warning" | "error" = "info") => latestUI?.notify(msg, type);

	// ── Firing ────────────────────────────────────────────────────────────

	// Deliver a fire: this is the only place fireCount moves, so the count always
	// equals fires the agent actually received.
	function deliverFire(entry: LoopEntry): void {
		dueLoops.delete(entry.id);
		const updated = store.update(entry.id, { fireCount: (entry.fireCount ?? 0) + 1 }) ?? entry;

		const payload: LoopFireEvent = {
			loopId: entry.id,
			prompt: entry.prompt,
			trigger: entry.trigger,
			timestamp: Date.now(),
			readOnly: entry.readOnly,
			recurring: entry.recurring,
		};
		pi.events.emit("loop:fire", payload);

		if (updated.maxFires && (updated.fireCount ?? 0) >= updated.maxFires) {
			store.setStatus(entry.id, "expired");
			triggers.remove(entry.id);
		}
		renderStatus();
	}

	function onLoopFire(entry: LoopEntry): void {
		if (entry.maxFires && (entry.fireCount ?? 0) >= entry.maxFires) {
			store.setStatus(entry.id, "expired");
			return;
		}
		if (entry.trigger.type === "self-paced") {
			lastSelfPacedId = entry.id;
			deliverFire(entry);
			return;
		}
		if (entry.trigger.type === "cron") {
			// A tick that lands mid-turn doesn't queue a stale prompt — it marks the
			// loop due, and the fire is delivered fresh once the agent goes idle.
			// Further ticks while due collapse into that one pending fire.
			const busy = latestCtx ? !latestCtx.isIdle() || latestCtx.hasPendingMessages() : false;
			if (busy) {
				dueLoops.add(entry.id);
				renderStatus();
				return;
			}
			deliverFire(entry);
			return;
		}
		// event / hybrid: deliver as a follow-up to the turn that caused the event,
		// but never stack fires while one is already queued.
		if (entry.recurring && latestCtx?.hasPendingMessages()) return;
		deliverFire(entry);
	}

	const scheduler = new CronScheduler(store, onLoopFire);
	const triggers = new TriggerSystem(pi, scheduler, store, onLoopFire);

	// Turn a delivered fire into an actual user message (followUp: starts a turn
	// when idle, otherwise lands right after the current turn).
	pi.events.on("loop:fire", (raw: unknown) => {
		const data = raw as LoopFireEvent;
		const constraint = data.readOnly ? READONLY_NOTE : "";
		const hint = data.trigger.type === "self-paced" ? SELF_PACED_HINT : "";
		const message = `[pi-loop] Loop #${data.loopId} fired (${describeTrigger(data.trigger)}).${constraint}\n\n${data.prompt}${hint}`;
		pi.sendUserMessage(message, { deliverAs: "followUp" });
		renderStatus();
	});

	// Fire any loops that came due while the agent was busy.
	function deliverDue(): void {
		for (const id of [...dueLoops]) {
			dueLoops.delete(id);
			const entry = store.get(id);
			if (entry && entry.status === "active") deliverFire(entry);
		}
	}

	function fireSelfPacedNow(entry: LoopEntry): void {
		onLoopFire(entry);
		renderStatus();
	}

	// Arm (or re-arm) the timer that delivers a self-paced loop's next iteration.
	// Shared by the model-driven schedule_loop_wakeup and the harness-driven
	// auto-continue, so both paths cancel cleanly via selfPacedTimers on stop.
	function armSelfPacedWakeup(id: string, delayMs: number): void {
		const existing = selfPacedTimers.get(id);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			selfPacedTimers.delete(id);
			selfPacedFireTimes.delete(id);
			const fresh = store.get(id);
			if (!fresh || fresh.status !== "active") return;
			if (Date.now() >= fresh.expiresAt) {
				stopLoop(id, "expired");
				return;
			}
			fireSelfPacedNow(fresh);
		}, delayMs);
		(timer as { unref?: () => void }).unref?.();
		selfPacedTimers.set(id, timer);
		selfPacedFireTimes.set(id, Date.now() + delayMs);
		renderStatus();
	}

	// Continuation is the harness's job: when a turn ends, re-arm every active
	// self-paced loop that the model didn't already schedule, so the loop survives
	// even if the model never calls schedule_loop_wakeup. The loop ends only on an
	// explicit signal — LoopDelete (model: "goal reached"), /loop stop, takeover,
	// maxFires, or expiry.
	function autoContinueSelfPaced(): void {
		// A fire (or a user message) is already queued — let its turn-end drive the
		// next continuation rather than arming one now, so iterations never stack.
		if (latestCtx?.hasPendingMessages()) return;
		for (const l of store.listActive()) {
			if (l.trigger.type !== "self-paced") continue;
			if (selfPacedTimers.has(l.id)) continue; // model already set the next iteration
			if (l.maxFires && (l.fireCount ?? 0) >= l.maxFires) {
				stopLoop(l.id, "maxFires reached");
				continue;
			}
			armSelfPacedWakeup(l.id, SELF_PACED_CONTINUE_MS);
		}
	}

	// ── Status widget ───────────────────────────────────────────────────────

	function renderStatus(): void {
		if (!latestUI) return;
		const active = store.listActive();
		if (active.length === 0) {
			latestUI.setStatus(STATUS_KEY, undefined);
			latestUI.setWidget(STATUS_KEY, undefined);
			stopTicker();
			return;
		}
		latestUI.setStatus(STATUS_KEY, `⟳ loop · ${active.length} active`);
		startTicker();
		const lines = active.map((l) => {
			const next = scheduler.nextFire(l.id);
			const wakeup = selfPacedFireTimes.get(l.id);
			const when =
				l.trigger.type === "self-paced"
					? wakeup
						? `next in ${formatRemaining(wakeup - Date.now())}`
						: "running · auto-continues"
					: dueLoops.has(l.id)
						? "due — fires when agent is idle"
						: next
							? `next ${formatRemaining(next - Date.now())}`
							: l.trigger.type === "event"
								? "on event"
								: "pending";
			const fires = l.maxFires ? ` ${l.fireCount ?? 0}/${l.maxFires}` : l.fireCount ? ` ${l.fireCount}×` : "";
			return `⟳ #${l.id} ${l.prompt.slice(0, 48)} — ${describeTrigger(l.trigger)} · ${when}${fires}`;
		});
		latestUI.setWidget(STATUS_KEY, lines);
	}

	function startTicker(): void {
		if (ticker) return;
		ticker = setInterval(() => renderStatus(), TICK_MS);
		(ticker as { unref?: () => void }).unref?.();
	}

	function stopTicker(): void {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	}

	// ── Loop lifecycle helpers ────────────────────────────────────────────

	function stopLoop(id: string, reason: string): boolean {
		triggers.remove(id);
		const t = selfPacedTimers.get(id);
		if (t) clearTimeout(t);
		selfPacedTimers.delete(id);
		selfPacedFireTimes.delete(id);
		dueLoops.delete(id);
		const existed = store.delete(id);
		if (existed) {
			renderStatus();
			notify(`Loop #${id} stopped (${reason}).`);
		}
		return existed;
	}

	function activateLoop(entry: LoopEntry): void {
		triggers.add(entry);
		if (entry.trigger.type === "self-paced") fireSelfPacedNow(entry);
		startTicker();
		renderStatus();
	}

	function validateTrigger(trigger: Trigger): string | null {
		if (trigger.type === "cron" && trigger.schedule.trim().split(/\s+/).length !== 5) {
			return `Invalid cron schedule "${trigger.schedule}". Expected 5 fields. Use "5m", "1h", or "0 9 * * 1-5".`;
		}
		if (trigger.type === "hybrid" && trigger.cron.trim().split(/\s+/).length !== 5) {
			return `Invalid hybrid cron part "${trigger.cron}". Expected 5 fields.`;
		}
		if ((trigger.type === "event" && !trigger.source.trim()) || (trigger.type === "hybrid" && !trigger.event.source.trim())) {
			return "Event source must be non-empty (e.g. tool_execution_end).";
		}
		return null;
	}

	// ── Tools ─────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "LoopCreate",
		label: "LoopCreate",
		description: `Schedule a repeating task that runs a prompt on a timer or when a pi event fires.

Trigger types:
- cron: time interval — "30s" (rounds to 1m), "5m", "2h", "1d", or a full cron like "0 9 * * 1-5".
- event: a pi event-bus channel — e.g. "tool_execution_end", "turn_end", "monitor:done".
- hybrid: cron + event with debounce.

Prefer LoopCreate over raw Bash sleep/while loops: it survives across turns and the scheduler owns the timing. Set maxFires on polling loops to bound token use, and call LoopDelete on a loop's own id when there's nothing left to do.`,
		promptGuidelines: [
			"Use LoopCreate for any repeating/periodic/scheduled task — never a raw Bash sleep/while loop.",
			"Default to a 5m interval unless the user asks otherwise; use event triggers when an exact pi event fits.",
			"Always set maxFires on polling loops (e.g. 20-50) to bound token usage.",
			"Tell the user the loop id so they can stop it with LoopDelete or /loop stop <id>.",
		],
		parameters: Type.Object({
			trigger: Type.String({ description: 'Interval ("5m", "1h", "0 9 * * *"), event source ("tool_execution_end"), or hybrid spec.' }),
			prompt: Type.String({ description: "Prompt to run when the loop fires." }),
			triggerType: Type.Optional(Type.String({ description: "cron | event | hybrid (inferred if omitted)", enum: ["cron", "event", "hybrid"] })),
			recurring: Type.Optional(Type.Boolean({ description: "Repeat (default true for cron/hybrid, false for event)." })),
			readOnly: Type.Optional(Type.Boolean({ description: "Restrict the agent to read-only tools on each fire." })),
			maxFires: Type.Optional(Type.Number({ description: "Auto-stop after N fires." })),
			debounceMs: Type.Optional(Type.Number({ description: "Debounce for hybrid triggers (default 30000)." })),
			filter: Type.Optional(Type.String({ description: 'Event filter: JSON match (e.g. {"monitorId":"1"}) or "regex:..."' })),
		}),
		execute: (_id, params) => {
			if (store.atCapacity()) return Promise.resolve(textResult("Maximum active loops reached (25). Delete some first."));

			const inferred = params.triggerType ?? inferTriggerType(params.trigger);
			let trigger: Trigger;
			try {
				if (inferred === "cron") {
					trigger = { type: "cron", schedule: parseInterval(params.trigger).cron };
				} else if (inferred === "event") {
					trigger = { type: "event", source: params.trigger.trim(), filter: params.filter };
				} else {
					const cronPart = params.trigger.match(/cron:?\s*(\S.*\S|\S)/)?.[1] ?? "5m";
					const eventPart = params.trigger.match(/event:?\s*(\S+)/)?.[1] ?? "tool_execution_end";
					trigger = {
						type: "hybrid",
						cron: parseInterval(cronPart).cron,
						event: { source: eventPart, filter: params.filter },
						debounceMs: params.debounceMs ?? DEFAULT_DEBOUNCE_MS,
					};
				}
			} catch (err) {
				return Promise.resolve(textResult((err as Error).message));
			}

			const validation = validateTrigger(trigger);
			if (validation) return Promise.resolve(textResult(validation));

			const entry = store.create(trigger, params.prompt, {
				recurring: params.recurring,
				readOnly: params.readOnly,
				maxFires: params.maxFires,
				source: "tool",
			});
			activateLoop(entry);

			return Promise.resolve(
				textResult(
					`Loop #${entry.id} created — ${describeTrigger(trigger)}\n` +
						`Recurring: ${entry.recurring}${entry.maxFires ? ` · maxFires ${entry.maxFires}` : ""}${entry.readOnly ? " · read-only" : ""}\n` +
						`Stop with LoopDelete id="${entry.id}" or /loop stop ${entry.id}.`,
				),
			);
		},
	});

	pi.registerTool({
		name: "LoopList",
		label: "LoopList",
		description: "List active scheduled loops with their ids, triggers, fire counts, and next-fire times.",
		parameters: Type.Object({}),
		execute: () => {
			const loops = store.list();
			if (loops.length === 0) return Promise.resolve(textResult("No loops configured."));
			const lines = loops.map((l) => {
				const next = l.trigger.type === "cron" || l.trigger.type === "hybrid" ? scheduler.nextFire(l.id) : undefined;
				const wakeup = l.trigger.type === "self-paced" ? selfPacedFireTimes.get(l.id) : undefined;
				const when = next
					? ` · next ${formatRemaining(next - Date.now())}`
					: wakeup
						? ` · wakeup in ${formatRemaining(wakeup - Date.now())}`
						: l.trigger.type === "self-paced" && l.status === "active"
							? " · running, auto-continues"
							: "";
				const fires = l.fireCount ? ` · ${l.fireCount} fires` : "";
				return `#${l.id} [${l.status}] ${l.prompt.slice(0, 60)} (${describeTrigger(l.trigger)})${when}${fires}`;
			});
			return Promise.resolve(textResult(lines.join("\n")));
		},
	});

	pi.registerTool({
		name: "LoopDelete",
		label: "LoopDelete",
		description: "Stop a loop by id (delete), or pause it to keep it in the list without firing.",
		parameters: Type.Object({
			id: Type.String({ description: "Loop id." }),
			action: Type.Optional(Type.String({ description: "delete | pause (default delete)", enum: ["delete", "pause"] })),
		}),
		execute: (_id, params) => {
			const entry = store.get(params.id);
			if (!entry) return Promise.resolve(textResult(`Loop #${params.id} not found.`));
			if (params.action === "pause") {
				triggers.remove(params.id);
				store.setStatus(params.id, "paused");
				renderStatus();
				return Promise.resolve(textResult(`Loop #${params.id} paused.`));
			}
			stopLoop(params.id, "deleted");
			return Promise.resolve(textResult(`Loop #${params.id} deleted.`));
		},
	});

	pi.registerTool({
		name: "schedule_loop_wakeup",
		label: "Schedule Loop Wakeup",
		description:
			"Optional cadence control for the active self-paced /loop. The loop ALREADY continues on its own after every turn — you do not need to call this to keep it alive. Call it only to set a custom gap before the next iteration (delaySeconds), e.g. to wait while something external finishes. To STOP the loop when the goal is achieved, call LoopDelete instead.",
		promptSnippet: "Set a custom delay before a self-paced /loop's next auto-iteration.",
		promptGuidelines: [
			"A self-paced /loop continues automatically — do NOT call schedule_loop_wakeup just to keep it going.",
			"Use it only to lengthen the gap before the next iteration (delaySeconds), e.g. 900 to wait 15 minutes.",
			"When the loop's goal is fully achieved, stop it with LoopDelete (not by staying silent).",
		],
		parameters: Type.Object({
			reason: Type.Optional(Type.String({ description: "Why this cadence (for your own tracking)." })),
			delaySeconds: Type.Optional(Type.Number({ description: "Delay before the next iteration, in seconds. Defaults to the loop's normal auto-continue gap." })),
			loopId: Type.Optional(Type.String({ description: "Which self-paced loop to schedule (defaults to the one that just fired)." })),
		}),
		execute: (_id, params) => {
			const targetId = params.loopId ?? lastSelfPacedId;
			const entry = targetId ? store.get(targetId) : undefined;
			if (!entry || entry.trigger.type !== "self-paced" || entry.status !== "active") {
				return Promise.resolve(textResult("No active self-paced loop to schedule; ignoring."));
			}
			const delayMs =
				params.delaySeconds === undefined
					? SELF_PACED_CONTINUE_MS
					: Math.max(0, Math.round(params.delaySeconds * 1000));
			armSelfPacedWakeup(entry.id, delayMs);
			return Promise.resolve(textResult(`Loop #${entry.id} will continue in ${formatRemaining(delayMs)}.`));
		},
	});

	// ── /loop command ─────────────────────────────────────────────────────

	pi.registerCommand("loop", {
		description: "Run a prompt repeatedly: /loop [interval] <prompt>. E.g. /loop 15m check the deploy. /loop stop to end.",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			if (/\s/.test(prefix)) return null;
			const items = [
				{ value: "stop", label: "stop — end loop(s)" },
				{ value: "list", label: "list — show active loops" },
			];
			const matches = items.filter((i) => i.value.startsWith(prefix));
			return matches.length ? matches : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			bindSession(ctx);

			const trimmed = args.trim();
			const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";

			// Stop
			if (first === "stop" || first === "off") {
				const id = trimmed.split(/\s+/)[1];
				if (id) {
					if (!stopLoop(id, "requested")) notify(`Loop #${id} not found.`, "warning");
					return;
				}
				const active = store.listActive();
				if (active.length === 0) {
					notify("No active loops.");
					return;
				}
				for (const l of active) stopLoop(l.id, "requested");
				notify(`Stopped ${active.length} loop${active.length === 1 ? "" : "s"}.`);
				return;
			}

			// List / menu
			if (first === "list" || (!trimmed && store.listActive().length > 0)) {
				const active = store.listActive();
				if (active.length === 0) {
					notify("No active loops.");
					return;
				}
				const choice = await ctx.ui.select(
					"Active loops",
					[...active.map((l) => `#${l.id} ${l.prompt.slice(0, 50)} (${describeTrigger(l.trigger)})`), "Stop all", "← Close"],
				);
				if (choice === "Stop all") {
					for (const l of active) stopLoop(l.id, "requested");
					notify(`Stopped ${active.length} loops.`);
				} else if (choice && choice.startsWith("#")) {
					const id = choice.slice(1).split(/\s/)[0];
					stopLoop(id, "requested");
				}
				return;
			}

			if (!trimmed) {
				notify("Usage: /loop [interval] <prompt> · /loop stop [id] · /loop list");
				return;
			}

			// Create: interval present → fixed cron loop; otherwise → self-paced.
			const { interval, prompt } = extractInterval(trimmed);
			if (interval) {
				if (!prompt) {
					notify("Provide a prompt: /loop 15m check the deploy", "warning");
					return;
				}
				let parsed: ReturnType<typeof parseInterval>;
				try {
					parsed = parseInterval(interval);
				} catch (err) {
					notify((err as Error).message, "error");
					return;
				}
				const entry = store.create({ type: "cron", schedule: parsed.cron }, prompt, { recurring: true, source: "command" });
				activateLoop(entry);
				notify(`Loop #${entry.id} started — every ${parsed.description}. /loop stop ${entry.id} to end.`);
				return;
			}

			const entry = store.create({ type: "self-paced" }, prompt, { recurring: true, source: "command" });
			notify(`Auto-looping #${entry.id} started — it repeats after each turn on its own. /loop stop ${entry.id} (or the model calling LoopDelete) ends it.`);
			activateLoop(entry);
		},
	});

	// ── Lifecycle ─────────────────────────────────────────────────────────

	// Bind the store, jitter seed, and timers to the current session. Runs at
	// session start (so restored loops arm and fire without waiting for the user
	// to type) and re-runs whenever the session id changes (/new, fork, resume),
	// so a new session never keeps firing the previous session's loops.
	function bindSession(ctx: ExtensionContext): void {
		latestCtx = ctx;
		latestUI = ctx.ui;
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId === boundSessionId) return;
		boundSessionId = sessionId;

		triggers.stop();
		for (const t of selfPacedTimers.values()) clearTimeout(t);
		selfPacedTimers.clear();
		selfPacedFireTimes.clear();
		dueLoops.clear();

		if (piLoopEnv !== "off") {
			try {
				store.setPath(resolveStorePath(sessionId));
			} catch {
				// keep in-memory store
			}
		}
		store.clearExpired();
		scheduler.setSeed(sessionId);
		triggers.start();
		renderStatus();
	}

	function captureCtx(ctx: ExtensionContext): void {
		bindSession(ctx);
		renderStatus();
	}

	pi.on("session_start", async (_event, ctx) => bindSession(ctx));
	pi.on("before_agent_start", async (_event, ctx) => captureCtx(ctx));
	pi.on("turn_start", async (_event, ctx) => captureCtx(ctx));
	pi.on("agent_end", async (_event, ctx) => {
		captureCtx(ctx);
		deliverDue();
		autoContinueSelfPaced();
	});

	// Typing while a self-paced loop is waiting ends it — you took over. Fixed and
	// event loops keep running (they fire between your turns by design).
	pi.on("input", (event) => {
		if (event.source === "interactive") {
			for (const l of store.listActive()) {
				if (l.trigger.type === "self-paced") stopLoop(l.id, "you took over");
			}
		}
		return { action: "continue" };
	});

	// Bridge selected lifecycle events onto the bus for event/hybrid triggers.
	// Cast past the per-event overloads — we only need a uniform (name, data) shape.
	const onAny = pi.on.bind(pi) as unknown as (event: string, handler: (data: unknown) => void) => void;
	for (const ev of BRIDGED_EVENTS) {
		onAny(ev, (data: unknown) => pi.events.emit(ev, data));
	}

	pi.on("session_shutdown", async () => {
		triggers.stop();
		for (const t of selfPacedTimers.values()) clearTimeout(t);
		selfPacedTimers.clear();
		selfPacedFireTimes.clear();
		dueLoops.clear();
		stopTicker();
	});
}
