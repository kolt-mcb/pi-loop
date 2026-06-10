// Shared types for the loop extension.

export type LoopStatus = "active" | "paused" | "expired";

/** Fixed cadence driven by a cron expression and a self-re-arming timer. */
export interface CronTrigger {
	type: "cron";
	schedule: string; // 5-field cron expression
}

/** Fires when a pi event-bus channel emits (optionally filtered). */
export interface EventTrigger {
	type: "event";
	source: string;
	filter?: string;
}

/** Cron cadence plus an event source, debounced so the two don't double-fire. */
export interface HybridTrigger {
	type: "hybrid";
	cron: string;
	event: { source: string; filter?: string };
	debounceMs: number;
}

/** Model-paced: only advances when the model calls the schedule-wakeup tool. */
export interface SelfPacedTrigger {
	type: "self-paced";
}

export type Trigger = CronTrigger | EventTrigger | HybridTrigger | SelfPacedTrigger;

/**
 * Where a loop came from. This decides takeover behaviour:
 *   - "command": created via `/loop`. Self-paced ones yield when the user types.
 *   - "tool":    created via LoopCreate. Runs as a background scheduled task.
 */
export type LoopSource = "command" | "tool";

export interface LoopEntry {
	id: string;
	prompt: string;
	trigger: Trigger;
	status: LoopStatus;
	recurring: boolean;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
	source: LoopSource;
	readOnly?: boolean;
	maxFires?: number;
	fireCount?: number;
}

export interface LoopStoreData {
	nextId: number;
	loops: LoopEntry[];
}

/** Payload emitted on the "loop:fire" channel when a loop is due. */
export interface LoopFireEvent {
	loopId: string;
	/** 1-based count of fires delivered for this loop (the iteration number). */
	iteration?: number;
	prompt: string;
	trigger: Trigger;
	timestamp: number;
	readOnly?: boolean;
	recurring: boolean;
}
