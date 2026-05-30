// Loop registry: an in-memory list with optional JSON persistence so unexpired
// loops survive a `--resume`/`--continue`, matching Claude Code's session-scoped
// scheduling. Set PI_LOOP=off to keep everything in memory only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LoopEntry, LoopStoreData, LoopStatus, Trigger } from "./types";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOOPS = 25;

export interface CreateOptions {
	recurring?: boolean;
	source?: LoopEntry["source"];
	readOnly?: boolean;
	maxFires?: number;
}

export class LoopStore {
	private data: LoopStoreData = { nextId: 1, loops: [] };
	private path: string | undefined;

	constructor(path?: string) {
		this.path = path;
		this.load();
	}

	/** Point the store at a (possibly session-specific) file and reload from it. */
	setPath(path: string | undefined): void {
		this.path = path;
		this.load();
	}

	private load(): void {
		if (!this.path || !existsSync(this.path)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as LoopStoreData;
			if (parsed && Array.isArray(parsed.loops)) {
				this.data = { nextId: parsed.nextId ?? 1, loops: parsed.loops };
			}
		} catch {
			// Corrupt or unreadable store — start fresh rather than crash the extension.
		}
	}

	private save(): void {
		if (!this.path) return;
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(this.path, JSON.stringify(this.data, null, 2));
		} catch {
			// Persistence is best-effort; never let a write failure break a fire.
		}
	}

	atCapacity(): boolean {
		return this.data.loops.filter((l) => l.status === "active").length >= MAX_LOOPS;
	}

	create(trigger: Trigger, prompt: string, opts: CreateOptions = {}): LoopEntry {
		const now = Date.now();
		const entry: LoopEntry = {
			id: String(this.data.nextId++),
			prompt,
			trigger,
			status: "active",
			recurring: opts.recurring ?? trigger.type !== "event",
			createdAt: now,
			updatedAt: now,
			expiresAt: now + SEVEN_DAYS_MS,
			source: opts.source ?? "tool",
			readOnly: opts.readOnly,
			maxFires: opts.maxFires,
			fireCount: 0,
		};
		this.data.loops.push(entry);
		this.save();
		return entry;
	}

	get(id: string): LoopEntry | undefined {
		return this.data.loops.find((l) => l.id === id);
	}

	list(): LoopEntry[] {
		return [...this.data.loops].sort((a, b) => Number(a.id) - Number(b.id));
	}

	listActive(): LoopEntry[] {
		return this.list().filter((l) => l.status === "active");
	}

	update(id: string, patch: Partial<LoopEntry>): LoopEntry | undefined {
		const entry = this.get(id);
		if (!entry) return undefined;
		Object.assign(entry, patch, { updatedAt: Date.now() });
		this.save();
		return entry;
	}

	delete(id: string): boolean {
		const before = this.data.loops.length;
		this.data.loops = this.data.loops.filter((l) => l.id !== id);
		const removed = this.data.loops.length < before;
		if (removed) this.save();
		return removed;
	}

	clearAll(): void {
		this.data = { nextId: 1, loops: [] };
		this.save();
	}

	/** Drop loops whose 7-day window has elapsed. Returns the ids removed. */
	clearExpired(now = Date.now()): string[] {
		const expired = this.data.loops.filter((l) => now >= l.expiresAt || l.status === "expired").map((l) => l.id);
		if (expired.length) {
			this.data.loops = this.data.loops.filter((l) => !expired.includes(l.id));
			this.save();
		}
		return expired;
	}

	setStatus(id: string, status: LoopStatus): void {
		this.update(id, { status });
	}
}
