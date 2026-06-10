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
			notify() {},
			setStatus() {},
			setWidget() {},
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
	const dispatch = async (event: string, ev?: unknown) => {
		for (const h of lifecycle.get(event) ?? []) await h(ev ?? { type: event }, ctx);
	};
	const callTool = async (name: string, params: unknown) => {
		const t = tools.get(name);
		if (!t) throw new Error(`tool ${name} not registered`);
		const res = await t.execute("call-id", params);
		return res.content.map((c) => c.text).join("\n");
	};
	return { sent, tools, command: command!, ctx, dispatch, callTool };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// ── Tests ───────────────────────────────────────────────────────────────

test("self-paced /loop fires immediately on creation", async () => {
	const { sent, command, ctx } = setup();
	await command.handler("fix decomp diffs", ctx);
	assert.equal(sent.length, 1);
	assert.match(sent[0].msg, /\[pi-loop\] Loop #1 fired \(self-paced\)/);
	assert.match(sent[0].msg, /fix decomp diffs/);
});

test("auto-continues after each turn with NO schedule_loop_wakeup call", async () => {
	const { sent, command, ctx, dispatch, callTool } = setup();
	await command.handler("grind the decomp", ctx);
	assert.equal(sent.length, 1, "first fire on creation");

	// Turn ends, model called nothing. Harness must re-fire on its own.
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 2, "auto-continued without a wakeup call");

	// And keeps going turn after turn.
	await dispatch("agent_end");
	await tick();
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 4, "keeps auto-continuing");
	assert.match(sent[3].msg, /Loop #1 fired/);

	// fireCount reflects delivered fires (the user's question).
	const list = await callTool("LoopList", {});
	assert.match(list, /4 fires/);
});

test("does not stack fires when a message is already pending", async () => {
	const { sent, command, ctx, dispatch } = setup({ hasPendingMessages: () => true });
	await command.handler("grind", ctx);
	assert.equal(sent.length, 1);

	// agent_end fires while a message is queued — should NOT arm another iteration.
	await dispatch("agent_end");
	await dispatch("agent_end");
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 1, "no extra fires while pending");
});

test("model LoopDelete is REFUSED for a user-started loop — it keeps running", async () => {
	const { sent, command, ctx, dispatch, callTool } = setup();
	await command.handler("write the next number forever", ctx);
	assert.equal(sent.length, 1);

	// The model decides the open-ended task is "done" and tries to stop it.
	const res = await callTool("LoopDelete", { id: "1" });
	assert.match(res, /started by the user|runs until they stop|Leaving it running/i);

	// It must keep firing regardless.
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 2, "user-started loop keeps running despite the model's delete attempt");
});

test("auto-loop fire prompt tells the model to just do the task, not manage the loop", async () => {
	const { sent, command, ctx } = setup();
	await command.handler("write the next highest number", ctx);
	assert.match(sent[0].msg, /runs until the user stops it/i);
	// Must not invite the model to stop, pace, or reschedule — the foot-guns.
	assert.match(sent[0].msg, /must NOT stop, pace, reschedule/i);
	assert.match(sent[0].msg, /no LoopDelete, no schedule_loop_wakeup/i);
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

test("model CAN still delete its own tool-created loop (guard is scoped to /loop)", async () => {
	const { callTool } = setup();
	const created = await callTool("LoopCreate", { trigger: "5m", prompt: "poll something" });
	assert.match(created, /Loop #1 created/i);
	const del = await callTool("LoopDelete", { id: "1" });
	assert.match(del, /deleted/i, "tool-created loops remain model-deletable");
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

test("schedule_loop_wakeup is a no-op for a user /loop — model can't impose its own cadence", async () => {
	const { sent, command, ctx, callTool, dispatch } = setup();
	await command.handler("grind", ctx);
	assert.equal(sent.length, 1);

	// Model tries to slow the loop to 5 minutes (the observed foot-gun).
	const res = await callTool("schedule_loop_wakeup", { delaySeconds: 300 });
	assert.match(res, /continues automatically|no action taken|cadence is the user/i);

	// It did NOT impose the 5-min wait — auto-continue still drives the default gap.
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 2, "loop keeps its own (user) cadence, not the model's 300s");
});
