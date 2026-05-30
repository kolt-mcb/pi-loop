// Run with: npm test  (tsx test/loop-parse.test.ts)
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeJitter, cronFieldMatches, cronToNextFire, extractInterval, parseInterval } from "../src/loop-parse";

test("parseInterval: clean intervals map to cron steps", () => {
	assert.equal(parseInterval("5m").cron, "*/5 * * * *");
	assert.equal(parseInterval("15m").cron, "*/15 * * * *");
	assert.equal(parseInterval("1h").cron, "0 * * * *");
	assert.equal(parseInterval("2h").cron, "0 */2 * * *");
	assert.equal(parseInterval("1d").cron, "0 0 * * *");
});

test("parseInterval: sub-minute rounds up to 1 minute", () => {
	assert.equal(parseInterval("30s").cron, "*/1 * * * *");
	assert.match(parseInterval("30s").description, /rounded to 1 minute/);
});

test("parseInterval: odd intervals snap to nearest clean step", () => {
	// 7m → nearest is 5m; 50m → nearest is 60m (1h)
	assert.equal(parseInterval("7m").cron, "*/5 * * * *");
	assert.match(parseInterval("7m").description, /rounded/);
	assert.equal(parseInterval("50m").cron, "0 * * * *");
});

test("parseInterval: full cron passes through", () => {
	assert.equal(parseInterval("0 9 * * 1-5").cron, "0 9 * * 1-5");
});

test("parseInterval: garbage throws", () => {
	assert.throws(() => parseInterval("a few minutes"));
});

test("extractInterval: leading bare token", () => {
	assert.deepEqual(extractInterval("15m find something broken"), {
		interval: "15m",
		prompt: "find something broken",
	});
	assert.deepEqual(extractInterval("30s ping"), { interval: "30s", prompt: "ping" });
});

test("extractInterval: trailing clause", () => {
	assert.deepEqual(extractInterval("check the deploy every 2 hours"), {
		interval: "2h",
		prompt: "check the deploy",
	});
	assert.deepEqual(extractInterval("poll ci every hour"), { interval: "1h", prompt: "poll ci" });
});

test("extractInterval: no interval → null + full prompt", () => {
	assert.deepEqual(extractInterval("find something missing or broken and fix it"), {
		interval: null,
		prompt: "find something missing or broken and fix it",
	});
	// "forever" is not an interval — it stays in the prompt, loop is just recurring.
	assert.equal(extractInterval("forever fix bugs").interval, null);
});

test("extractInterval: leading full cron", () => {
	assert.deepEqual(extractInterval("0 9 * * 1-5 morning standup"), {
		interval: "0 9 * * 1-5",
		prompt: "morning standup",
	});
});

test("cronFieldMatches: wildcards, steps, ranges, lists", () => {
	assert.ok(cronFieldMatches("*", 7));
	assert.ok(cronFieldMatches("*/5", 15));
	assert.ok(!cronFieldMatches("*/5", 7));
	assert.ok(cronFieldMatches("1-5", 3));
	assert.ok(!cronFieldMatches("1-5", 6));
	assert.ok(cronFieldMatches("1,15,30", 15));
});

test("cronToNextFire: every 5 minutes lands on a multiple of 5", () => {
	const from = new Date("2026-01-01T10:02:00");
	const next = cronToNextFire("*/5 * * * *", from);
	assert.equal(next.getMinutes() % 5, 0);
	assert.ok(next.getTime() > from.getTime());
});

test("computeJitter: deterministic and bounded", () => {
	const a = computeJitter("42", true, 15);
	const b = computeJitter("42", true, 15);
	assert.equal(a, b); // stable for the same id
	assert.ok(a >= 0 && a <= (15 / 2) * 60 * 1000);
});
