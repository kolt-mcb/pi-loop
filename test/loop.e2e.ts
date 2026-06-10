// End-to-end tests for the model-driven self-paced /loop.
//
// These drive a REAL pi process (under a pty) against the configured model, so
// they are slow and non-deterministic — they are deliberately NOT part of the
// fast unit suite (`npm test` globs *.test.ts). Run them with `npm run test:e2e`.
// They self-skip when pi (or a working model) isn't available.
//
// What they pin down — the behaviour validated by hand while building the
// Claude-style model-driven loop:
//   - count-to-N: the model continues each turn and STOPS itself at the goal
//     (omit-to-end), with exactly fires-1 schedule_loop_wakeup calls.
//   - die-roll-until-6: a stochastic stop the model can't pre-plan — it must
//     continue on every non-6 and stop on the runtime-random 6. A 6 can only
//     ever be the final roll, and the loop ends only on a 6.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const PI = process.env.PI_BIN ?? "pi";

function havePi(): boolean {
	try {
		execFileSync("bash", ["-lc", `command -v ${PI}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

interface RunResult {
	fires: number;
	wakeups: Array<{ delaySeconds?: number; reason?: string }>;
	bashRolls: number[]; // single-digit 1-6 results of bash calls (real shuf draws)
	loopEnded: boolean; // no active self-paced loop left in the store
	file(name: string): string | undefined;
}

// Run an interactive /loop headless under a pty until the timeout kills it
// (interactive pi never exits on its own), then parse the session + working dir.
function runLoop(prompt: string, timeoutSec: number): RunResult {
	const dir = mkdtempSync(join(tmpdir(), "piloop-e2e-"));
	const sessionDir = join(dir, ".sess");
	try {
		execFileSync("script", ["-qefc", `${PI} "/loop $PI_LOOP_PROMPT" --session-dir "${sessionDir}"`, join(dir, "pi.log")], {
			cwd: dir,
			env: { ...process.env, PI_LOOP_PROMPT: prompt },
			timeout: timeoutSec * 1000,
			stdio: "ignore",
		});
	} catch {
		// The timeout kill is expected — the loop self-terminates but pi keeps idling.
	}

	// Snapshot top-level working-dir files NOW — the temp dir is removed before
	// runLoop returns, so a lazy read in the test would see nothing.
	const files: Record<string, string> = {};
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		try {
			if (statSync(p).isFile()) files[f] = readFileSync(p, "utf8").trim();
		} catch {
			// ignore
		}
	}

	const out: RunResult = {
		fires: 0,
		wakeups: [],
		bashRolls: [],
		loopEnded: false,
		file: (name) => files[name],
	};

	const sess = existsSync(sessionDir)
		? readdirSync(sessionDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => ({ f, t: statSync(join(sessionDir, f)).mtimeMs }))
				.sort((a, b) => b.t - a.t)[0]?.f
		: undefined;

	if (sess) {
		for (const line of readFileSync(join(sessionDir, sess), "utf8").split("\n")) {
			if (!line.trim()) continue;
			let d: { message?: { role?: string; content?: unknown } };
			try {
				d = JSON.parse(line);
			} catch {
				continue;
			}
			const content = d.message?.content;
			if (d.message?.role === "user" && Array.isArray(content)) {
				const txt = content.map((c: { text?: string }) => c?.text ?? "").join(" ");
				if (txt.includes("[pi-loop]")) out.fires++;
			}
			if (Array.isArray(content)) {
				for (const c of content as Array<{ type?: string; name?: string; toolName?: string; arguments?: unknown; content?: Array<{ text?: string }> }>) {
					if (c?.type === "toolCall" && c?.name === "schedule_loop_wakeup") out.wakeups.push((c.arguments ?? {}) as { delaySeconds?: number });
					if (c?.type === "toolResult" && c?.toolName === "bash") {
						const t = (c.content ?? []).map((x) => x?.text ?? "").join("").trim();
						if (/^[1-6]$/.test(t)) out.bashRolls.push(Number(t));
					}
				}
			}
		}
	}

	const loopsDir = join(dir, ".pi", "loops");
	let active = false;
	if (existsSync(loopsDir)) {
		for (const f of readdirSync(loopsDir)) {
			try {
				const data = JSON.parse(readFileSync(join(loopsDir, f), "utf8")) as { loops?: Array<{ status?: string; trigger?: { type?: string } }> };
				if ((data.loops ?? []).some((l) => l.status === "active" && l.trigger?.type === "self-paced")) active = true;
			} catch {
				// ignore unreadable store
			}
		}
	}
	out.loopEnded = out.fires > 0 && !active;

	rmSync(dir, { recursive: true, force: true });
	return out;
}

const SKIP = !havePi();

test("count-to-5: continues to the goal, then stops itself (omit-to-end)", { skip: SKIP, timeout: 240_000 }, (t) => {
	const r = runLoop(
		"write the next number into count.txt (start at 1, add 1 each iteration). When it reaches 5, stop and do not schedule another iteration.",
		180,
	);
	if (r.fires === 0) return t.skip("no loop fires — pi/model unavailable");

	assert.equal(r.file("count.txt"), "5", "counter reached the goal value");
	assert.ok(r.loopEnded, "loop self-terminated at the goal (store has no active self-paced loop)");
	assert.equal(r.wakeups.length, r.fires - 1, "continued every turn but the last (omit-to-end)");
});

test("die-roll-until-6: continues on non-6, stops only on the runtime-random 6", { skip: SKIP, timeout: 280_000 }, (t) => {
	const r = runLoop(
		"roll a six-sided die with: shuf -i 1-6 -n 1, and append the rolled number on its own line to rolls.txt. If you roll a 6, the goal is met: stop and do NOT schedule another iteration. Otherwise schedule the next iteration.",
		220,
	);
	if (r.fires === 0) return t.skip("no loop fires — pi/model unavailable");

	const seq = (r.file("rolls.txt") ?? "").split("\n").filter(Boolean).map(Number);
	assert.ok(seq.length >= 1, "rolled at least once");
	assert.ok(seq.every((n) => n >= 1 && n <= 6), "every recorded roll is a valid 1-6 face");
	assert.ok(r.bashRolls.length >= 1, "rolls came from real shell draws (not hallucinated)");

	// Core invariant: a 6 stops the loop, so a 6 can only ever be the LAST roll.
	assert.ok(seq.slice(0, -1).every((n) => n !== 6), "no 6 appears before the final roll");

	// And the loop ends ONLY because of a 6.
	if (r.loopEnded) {
		assert.equal(seq[seq.length - 1], 6, "the loop stopped on a 6");
	}
});
