// Event + hybrid trigger wiring. Cron cadence lives in CronScheduler; this layer
// subscribes loops to pi event-bus channels and debounces hybrid loops so the
// cron tick and the event don't both fire within the debounce window.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CronScheduler } from "./scheduler";
import type { LoopStore } from "./store";
import type { LoopEntry } from "./types";

export class TriggerSystem {
	private unsubs = new Map<string, () => void>();
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private lastFire = new Map<string, number>();

	constructor(
		private pi: ExtensionAPI,
		private scheduler: CronScheduler,
		private store: LoopStore,
		private fire: (entry: LoopEntry) => void,
	) {}

	start(): void {
		this.scheduler.start();
		for (const entry of this.store.listActive()) {
			if (entry.trigger.type === "event" || entry.trigger.type === "hybrid") this.subscribe(entry);
		}
	}

	stop(): void {
		this.scheduler.stop();
		for (const unsub of this.unsubs.values()) unsub();
		this.unsubs.clear();
		for (const timer of this.debounceTimers.values()) clearTimeout(timer);
		this.debounceTimers.clear();
		this.lastFire.clear();
	}

	add(entry: LoopEntry): void {
		if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid") this.scheduler.add(entry);
		if (entry.trigger.type === "event" || entry.trigger.type === "hybrid") this.subscribe(entry);
	}

	remove(id: string): void {
		this.scheduler.remove(id);
		this.unsubs.get(id)?.();
		this.unsubs.delete(id);
		const t = this.debounceTimers.get(id);
		if (t) clearTimeout(t);
		this.debounceTimers.delete(id);
		this.lastFire.delete(id);
	}

	private subscribe(entry: LoopEntry): void {
		const trig = entry.trigger;
		const source = trig.type === "hybrid" ? trig.event.source : trig.type === "event" ? trig.source : null;
		const filter = trig.type === "hybrid" ? trig.event.filter : trig.type === "event" ? trig.filter : undefined;
		if (!source) return;

		this.unsubs.get(entry.id)?.(); // avoid duplicate subscriptions on re-add
		const unsub = this.pi.events.on(source, (data: unknown) => {
			if (!this.matchesFilter(data, filter)) return;
			if (entry.trigger.type === "hybrid") this.debouncedFire(entry);
			else this.fireOnce(entry);
		});
		this.unsubs.set(entry.id, unsub);
	}

	/** Fire, then tear down the subscription if the loop is one-shot. */
	private fireOnce(entry: LoopEntry): void {
		const current = this.store.get(entry.id);
		if (!current || current.status !== "active") {
			this.remove(entry.id);
			return;
		}
		this.fire(current);
		const fresh = this.store.get(entry.id);
		if (!fresh) return;
		if (!fresh.recurring || (fresh.maxFires && (fresh.fireCount ?? 0) >= fresh.maxFires)) {
			this.store.setStatus(entry.id, "expired");
			this.remove(entry.id);
		}
	}

	private debouncedFire(entry: LoopEntry): void {
		const debounceMs = entry.trigger.type === "hybrid" ? entry.trigger.debounceMs : 0;
		const last = this.lastFire.get(entry.id) ?? 0;
		const remaining = debounceMs - (Date.now() - last);

		const existing = this.debounceTimers.get(entry.id);
		if (existing) clearTimeout(existing);

		if (remaining <= 0) {
			this.lastFire.set(entry.id, Date.now());
			this.fireOnce(entry);
			return;
		}
		const timer = setTimeout(() => {
			this.debounceTimers.delete(entry.id);
			this.lastFire.set(entry.id, Date.now());
			this.fireOnce(entry);
		}, remaining);
		(timer as { unref?: () => void }).unref?.();
		this.debounceTimers.set(entry.id, timer);
	}

	private matchesFilter(data: unknown, filter?: string): boolean {
		if (!filter) return true;
		if (filter.startsWith("regex:")) {
			try {
				return new RegExp(filter.slice(6)).test(JSON.stringify(data));
			} catch {
				return false;
			}
		}
		try {
			const parsed = JSON.parse(filter) as Record<string, unknown>;
			const obj = (data ?? {}) as Record<string, unknown>;
			for (const [key, value] of Object.entries(parsed)) {
				const actual = obj[key];
				if (actual === undefined) return false;
				if (typeof value === "object" && typeof actual === "object") {
					if (JSON.stringify(value) !== JSON.stringify(actual)) return false;
				} else if (String(actual) !== String(value)) {
					return false;
				}
			}
			return true;
		} catch {
			return true;
		}
	}
}
