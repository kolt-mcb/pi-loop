// Integration test for the 0.3.0 auto-continue behaviour of self-paced loops.
//
// Drives the extension against a mock pi ExtensionAPI and asserts that a
// no-interval /loop keeps firing on its own after each turn WITHOUT the model
// ever calling schedule_loop_wakeup — and that it stops only on an explicit
// signal (LoopDelete, interactive takeover). This is the behaviour the unit
// parse tests can't cover, and the exact failure the user hit (loop dying when
// the model forgot to reschedule).
//
// Env must be set before importing loop.ts: SELF_PACED_CONTINUE_MS is read once
// at module load, so we pin the gap to 0ms (fires on the next macrotask) and
// keep the store in memory (no .pi/loops writes).
process.env.PI_LOOP = "off";
process.env.PI_LOOP_CONTINUE_MS = "0";

import assert from "node:assert/strict";
import { test } from "node:test";

const { default: loopExtension } = await import("../loop");

// ── Mock pi harness ───────────────────────────────────────────────────────

function makeEvents() {
	const handlers = new Map<string, Set<(d: unknown) => void>>();
	return {
		on(name: string, fn: (d: unknown) => void) {
			let set = handlers.get(name);
			if (!set) handlers.set(name, (set = new Set()));
			set.add(fn);
			return () => set!.delete(fn);
		},
		emit(name: string, payload: unknown) {
			for (const fn of handlers.get(name) ?? []) fn(payload);
		},
	};
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		ui: {
			notify(_msg?: unknown, _type?: unknown) {},
			setStatus(_key?: unknown, _val?: unknown) {},
			setWidget(_key?: unknown, _val?: unknown) {},
			select: async () => "",
		},
		hasUI: true,
		cwd: "/tmp/pi-loop-test",
		sessionManager: { getSessionId: () => "test-session" },
		modelRegistry: {},
		model: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		abort() {},
		shutdown() {},
		getContextUsage() {},
		compact() {},
		getSystemPrompt: () => "",
		...overrides,
	};
}

// Build a fresh extension instance with its own in-memory store per test.
function setup(ctxOverrides: Record<string, unknown> = {}) {
	const sent: Array<{ msg: string; opts: unknown }> = [];
	const lifecycle = new Map<string, Array<(ev: unknown, ctx: unknown) => unknown>>();
	const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> }>();
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	const events = makeEvents();

	const pi = {
		events,
		on(event: string, handler: (ev: unknown, ctx: unknown) => unknown) {
			let arr = lifecycle.get(event);
			if (!arr) lifecycle.set(event, (arr = []));
			arr.push(handler);
		},
		sendUserMessage(msg: string, opts: unknown) {
			sent.push({ msg, opts });
		},
		registerTool(def: { name: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> }) {
			tools.set(def.name, def);
		},
		registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			if (name === "loop") command = def;
		},
	};

	// biome-ignore lint/suspicious/noExplicitAny: mock shape
	loopExtension(pi as any);

	const ctx = makeCtx(ctxOverrides);
	// Capture the latest status-widget lines for assertions.
	const widget: { lines: string[] } = { lines: [] };
	ctx.ui.setWidget = (_key: string, lines: unknown) => {
		widget.lines = Array.isArray(lines) ? (lines as string[]) : [];
	};
	const dispatch = async (event: string, ev?: unknown) => {
		for (const h of lifecycle.get(event) ?? []) await h(ev ?? { type: event }, ctx);
	};
	const callTool = async (name: string, params: unknown) => {
		const t = tools.get(name);
		if (!t) throw new Error(`tool ${name} not registered`);
		const res = await t.execute("call-id", params);
		return res.content.map((c) => c.text).join("\n");
	};
	return { sent, tools, command: command!, ctx, dispatch, callTool, widget };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// ── Tests ───────────────────────────────────────────────────────────────

test("self-paced /loop fires immediately on creation", async () => {
	const { sent, command, ctx } = setup();
	await command.handler("fix decomp diffs", ctx);
	assert.equal(sent.length, 1);
	assert.match(sent[0].msg, /\[pi-loop\] Iteration #1 \(self-paced\)/);
	assert.match(sent[0].msg, /fix decomp diffs/);
});

test("ENDS if the model does NOT call schedule_loop_wakeup (omit-to-end)", async () => {
	const { sent, command, ctx, dispatch, callTool } = setup();
	await command.handler("grind the decomp", ctx);
	assert.equal(sent.length, 1, "first fire on creation");

	// Turn ends, model called nothing → loop ends, no re-fire.
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 1, "no continuation scheduled → no re-fire");
	const list = await callTool("LoopList", {});
	assert.match(list, /No loops configured/i, "the loop is gone");
});

test("CONTINUES turn after turn when the model calls schedule_loop_wakeup", async () => {
	const { sent, command, ctx, dispatch, callTool } = setup();
	await command.handler("grind the decomp", ctx);
	assert.equal(sent.length, 1, "first fire on creation");

	// Model schedules the next iteration, then the turn ends → it fires.
	await callTool("schedule_loop_wakeup", { delaySeconds: 0 });
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 2, "continued because the model scheduled a wakeup");

	// Keeps going as long as the model keeps calling it.
	await callTool("schedule_loop_wakeup", { delaySeconds: 0 });
	await dispatch("agent_end");
	await tick();
	await callTool("schedule_loop_wakeup", { delaySeconds: 0 });
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 4, "keeps continuing per the model's calls");
	assert.match(sent[0].msg, /Iteration #1 \(self-paced\)/);
	assert.match(sent[3].msg, /Iteration #4 \(self-paced\)/);

	const list = await callTool("LoopList", {});
	assert.match(list, /4 fires/);
});

test("self-paced widget leads with the climbing iteration count (not the loop id)", async () => {
	const { command, ctx, dispatch, callTool, widget } = setup();
	await command.handler("write the next highest number into a count.txt file", ctx);
	assert.match(widget.lines[0], /^⟳ #1 /, "first iteration shows #1");
	assert.doesNotMatch(widget.lines[0], /auto-continues|\d×/, "no 'auto-continues' / 'N×' noise");

	await callTool("schedule_loop_wakeup", { delaySeconds: 0 });
	await dispatch("agent_end");
	await tick();
	assert.match(widget.lines[0], /^⟳ #2 /, "iteration climbs to #2 on the next run");
});

test("self-paced fire prompt is the model-driven (omit-to-end) hint", async () => {
	const { sent, command, ctx } = setup();
	await command.handler("write the next highest number", ctx);
	assert.match(sent[0].msg, /Self-paced loop/i);
	assert.match(sent[0].msg, /schedule_loop_wakeup at the end of your turn/i);
	assert.match(sent[0].msg, /Omit the call to end the loop/i);
});

test("user /loop stop ends a loop", async () => {
	const { sent, command, ctx, dispatch } = setup();
	await command.handler("grind", ctx);
	assert.equal(sent.length, 1);

	await command.handler("stop", ctx);
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 1, "the user (via /loop stop) ends it");
});

test("model can LoopDelete a user-started /loop (and stop it)", async () => {
	const { sent, command, ctx, dispatch, callTool } = setup();
	await command.handler("grind", ctx);
	assert.equal(sent.length, 1);

	const del = await callTool("LoopDelete", { id: "1" });
	assert.match(del, /deleted/i, "the agent may end a user /loop when it decides to");

	// Deleted loop does not fire again.
	await callTool("schedule_loop_wakeup", { delaySeconds: 0 });
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 1, "no re-fire after delete");
});

test("model can also delete its own tool-created loop", async () => {
	const { callTool } = setup();
	const created = await callTool("LoopCreate", { trigger: "5m", prompt: "poll something" });
	assert.match(created, /Loop #1 created/i);
	const del = await callTool("LoopDelete", { id: "1" });
	assert.match(del, /deleted/i);
});

test("interactive typing (takeover) stops the loop", async () => {
	const { sent, command, ctx, dispatch } = setup();
	await command.handler("grind", ctx);
	assert.equal(sent.length, 1);

	// User types — source "interactive" triggers takeover.
	await dispatch("input", { source: "interactive" });

	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 1, "takeover stops the loop");
});

test("schedule_loop_wakeup with a delay shows a 'next in' countdown and doesn't fire early", async () => {
	const { sent, command, ctx, callTool, dispatch, widget } = setup();
	await command.handler("poll the build", ctx);
	assert.equal(sent.length, 1);

	// Model asks to wait 5 minutes before the next iteration.
	const res = await callTool("schedule_loop_wakeup", { delaySeconds: 300, reason: "waiting for the build" });
	assert.match(res, /next iteration in/i);
	await dispatch("agent_end");
	await tick();
	// It armed a 5-min timer — no immediate re-fire, and the widget shows the wait.
	assert.equal(sent.length, 1, "does not fire before the delay elapses");
	assert.match(widget.lines[0], /next in/i);
});
