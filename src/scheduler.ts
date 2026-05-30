// Cron scheduler. The core of the timer-driven design: after each fire it
// re-arms its own timer, so continuation is the DEFAULT. A loop stops only when
// it expires, hits maxFires, is paused/deleted — never because the model forgot
// to do anything.

import { computeJitter, cronToNextFire } from "./loop-parse";
import type { LoopStore } from "./store";
import type { LoopEntry } from "./types";

function cronOf(entry: LoopEntry): string | undefined {
	if (entry.trigger.type === "cron") return entry.trigger.schedule;
	if (entry.trigger.type === "hybrid") return entry.trigger.cron;
	return undefined;
}

export class CronScheduler {
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private fireTimes = new Map<string, number>();

	constructor(
		private store: LoopStore,
		private onFire: (entry: LoopEntry) => void,
	) {}

	/** Arm timers for every active cron/hybrid loop currently in the store. */
	start(): void {
		for (const entry of this.store.listActive()) {
			if (cronOf(entry)) this.armTimer(entry);
		}
	}

	stop(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.fireTimes.clear();
	}

	add(entry: LoopEntry): void {
		if (cronOf(entry)) this.armTimer(entry);
	}

	remove(id: string): void {
		const timer = this.timers.get(id);
		if (timer) clearTimeout(timer);
		this.timers.delete(id);
		this.fireTimes.delete(id);
	}

	/** Wall-clock ms of the next scheduled fire for a loop, if armed. */
	nextFire(id: string): number | undefined {
		return this.fireTimes.get(id);
	}

	private armTimer(entry: LoopEntry): void {
		const schedule = cronOf(entry);
		if (!schedule) return;

		const next = cronToNextFire(schedule, new Date());
		const minuteField = schedule.trim().split(/\s+/)[0];
		const stepMinutes = minuteField.startsWith("*/") ? parseInt(minuteField.slice(2), 10) || 30 : 30;
		const fireTime = next.getTime() + computeJitter(entry.id, entry.recurring, stepMinutes);

		if (fireTime > entry.expiresAt) {
			this.store.setStatus(entry.id, "expired");
			this.remove(entry.id);
			return;
		}

		this.fireTimes.set(entry.id, fireTime);
		const existing = this.timers.get(entry.id);
		if (existing) clearTimeout(existing);

		const delay = Math.max(0, fireTime - Date.now());
		const timer = setTimeout(() => this.fire(entry.id), delay);
		// Don't keep the process alive solely for a pending loop tick.
		(timer as { unref?: () => void }).unref?.();
		this.timers.set(entry.id, timer);
	}

	private fire(id: string): void {
		const current = this.store.get(id);
		if (!current || current.status !== "active") {
			this.remove(id);
			return;
		}
		if (Date.now() >= current.expiresAt) {
			this.store.setStatus(id, "expired");
			this.remove(id);
			return;
		}

		this.onFire(current);

		// Re-read after onFire (it bumps fireCount) to decide whether to continue.
		const fresh = this.store.get(id);
		if (!fresh || fresh.status !== "active" || !fresh.recurring) {
			this.remove(id);
			return;
		}
		if (fresh.maxFires && (fresh.fireCount ?? 0) >= fresh.maxFires) {
			this.store.setStatus(id, "expired");
			this.remove(id);
			return;
		}
		this.armTimer(fresh); // ← re-arm: the loop keeps going on its own.
	}
}
