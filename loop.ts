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
 *   - Fires are delivered between turns (deliverAs "followUp"); a recurring fire
 *     is skipped while messages are already queued, so ticks never stack.
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

const SELF_PACED_HINT =
	"\n\n[Self-paced loop: call the schedule_loop_wakeup tool at the END of your turn to run this again, or omit it to end the loop.]";

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
	let started = false;
	let lastSelfPacedId: string | undefined;
	const selfPacedTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let ticker: ReturnType<typeof setInterval> | undefined;

	const notify = (msg: string, type: "info" | "warning" | "error" = "info") => latestUI?.notify(msg, type);

	// ── Firing ────────────────────────────────────────────────────────────

	function onLoopFire(entry: LoopEntry): void {
		if (entry.maxFires && (entry.fireCount ?? 0) >= entry.maxFires) {
			store.setStatus(entry.id, "expired");
			return;
		}
		store.update(entry.id, { fireCount: (entry.fireCount ?? 0) + 1 });
		if (entry.trigger.type === "self-paced") lastSelfPacedId = entry.id;

		const payload: LoopFireEvent = {
			loopId: entry.id,
			prompt: entry.prompt,
			trigger: entry.trigger,
			timestamp: Date.now(),
			readOnly: entry.readOnly,
			recurring: entry.recurring,
		};
		pi.events.emit("loop:fire", payload);
	}

	const scheduler = new CronScheduler(store, onLoopFire);
	const triggers = new TriggerSystem(pi, scheduler, store, onLoopFire);

	// Turn a due loop into an actual user message. Delivered as a follow-up so pi
	// queues it until the current turn ends; recurring fires are dropped while a
	// message is already pending so ticks don't pile up.
	pi.events.on("loop:fire", (raw: unknown) => {
		const data = raw as LoopFireEvent;
		if (data.recurring && latestCtx?.hasPendingMessages()) return;

		const constraint = data.readOnly ? READONLY_NOTE : "";
		const hint = data.trigger.type === "self-paced" ? SELF_PACED_HINT : "";
		const message = `[pi-loop] Loop #${data.loopId} fired (${describeTrigger(data.trigger)}).${constraint}\n\n${data.prompt}${hint}`;
		pi.sendUserMessage(message, { deliverAs: "followUp" });
		renderStatus();
	});

	function fireSelfPacedNow(entry: LoopEntry): void {
		onLoopFire(entry);
		renderStatus();
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
		const lines = active.map((l) => {
			const next = scheduler.nextFire(l.id);
			const when =
				l.trigger.type === "self-paced"
					? "waiting for model"
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
				const when = next ? ` · next ${formatRemaining(next - Date.now())}` : "";
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
			"Continue the active self-paced /loop. Call this once, at the END of your turn, to be re-invoked with the same loop prompt. If you do not call it, the self-paced loop ends.",
		promptSnippet: "Continue a self-paced /loop by requesting another iteration.",
		promptGuidelines: [
			"Only relevant while a self-paced /loop is active.",
			"Call schedule_loop_wakeup once at the end of a turn to keep looping; omit it to stop.",
			"Pass delaySeconds to control the gap before the next iteration (e.g. 900 for 15 minutes).",
		],
		parameters: Type.Object({
			reason: Type.Optional(Type.String({ description: "Why to continue (for your own tracking)." })),
			delaySeconds: Type.Optional(Type.Number({ description: "Delay before the next iteration, in seconds." })),
			loopId: Type.Optional(Type.String({ description: "Which self-paced loop to continue (defaults to the one that just fired)." })),
		}),
		execute: (_id, params) => {
			const targetId = params.loopId ?? lastSelfPacedId;
			const entry = targetId ? store.get(targetId) : undefined;
			if (!entry || entry.trigger.type !== "self-paced" || entry.status !== "active") {
				return Promise.resolve(textResult("No active self-paced loop to continue; ignoring."));
			}
			const delayMs = Math.max(0, Math.round((params.delaySeconds ?? 0) * 1000));
			const existing = selfPacedTimers.get(entry.id);
			if (existing) clearTimeout(existing);
			const timer = setTimeout(() => {
				selfPacedTimers.delete(entry.id);
				const fresh = store.get(entry.id);
				if (fresh && fresh.status === "active") fireSelfPacedNow(fresh);
			}, delayMs);
			(timer as { unref?: () => void }).unref?.();
			selfPacedTimers.set(entry.id, timer);
			const when = delayMs ? ` in ${delayMs / 1000}s` : "";
			return Promise.resolve(textResult(`Loop #${entry.id} will continue${when}.`));
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
			latestCtx = ctx;
			latestUI = ctx.ui;
			ensureStarted(ctx);

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
			notify(`Self-paced loop #${entry.id} started. It continues only if the model schedules a wakeup.`);
			activateLoop(entry);
		},
	});

	// ── Lifecycle ─────────────────────────────────────────────────────────

	function ensureStarted(ctx: ExtensionContext): void {
		if (started) return;
		started = true;
		if (piLoopEnv !== "off") {
			try {
				store.setPath(resolveStorePath(ctx.sessionManager.getSessionId()));
			} catch {
				// keep in-memory store
			}
		}
		store.clearExpired();
		triggers.start();
		renderStatus();
	}

	function captureCtx(ctx: ExtensionContext): void {
		latestCtx = ctx;
		latestUI = ctx.ui;
		ensureStarted(ctx);
		renderStatus();
	}

	pi.on("before_agent_start", async (_event, ctx) => captureCtx(ctx));
	pi.on("turn_start", async (_event, ctx) => captureCtx(ctx));

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
		stopTicker();
	});
}
