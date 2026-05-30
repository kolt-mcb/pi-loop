// Pure interval/cron helpers. No pi dependencies so these stay unit-testable.

const UNIT_SECONDS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3600,
	d: 86400,
};

// Intervals that map cleanly onto a cron step. Anything else snaps to the nearest.
const COMMON_INTERVALS: Record<number, string> = {
	60: "*/1 * * * *",
	120: "*/2 * * * *",
	300: "*/5 * * * *",
	600: "*/10 * * * *",
	900: "*/15 * * * *",
	1800: "*/30 * * * *",
	3600: "0 * * * *",
	7200: "0 */2 * * *",
	10800: "0 */3 * * *",
	14400: "0 */4 * * *",
	21600: "0 */6 * * *",
	28800: "0 */8 * * *",
	43200: "0 */12 * * *",
	86400: "0 0 * * *",
};

const WORD_UNIT: Record<string, string> = {
	second: "s",
	seconds: "s",
	sec: "s",
	secs: "s",
	minute: "m",
	minutes: "m",
	min: "m",
	mins: "m",
	hour: "h",
	hours: "h",
	hr: "h",
	hrs: "h",
	day: "d",
	days: "d",
};

export interface ParsedInterval {
	cron: string;
	description: string;
}

function describeSeconds(seconds: number): string {
	const mins = seconds / 60;
	if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""}`;
	const hrs = mins / 60;
	if (hrs % 24 === 0) {
		const days = hrs / 24;
		return `${days} day${days !== 1 ? "s" : ""}`;
	}
	return `${hrs} hour${hrs !== 1 ? "s" : ""}`;
}

function snapToCommon(seconds: number): ParsedInterval {
	const keys = Object.keys(COMMON_INTERVALS)
		.map(Number)
		.sort((a, b) => a - b);
	let best = keys[0];
	for (const k of keys) {
		if (Math.abs(k - seconds) < Math.abs(best - seconds)) best = k;
	}
	const exact = best === seconds ? "" : ` (rounded to ${describeSeconds(best)})`;
	return { cron: COMMON_INTERVALS[best], description: `${describeSeconds(seconds)}${exact}` };
}

function isFullCron(expr: string): boolean {
	const fields = expr.trim().split(/\s+/);
	// 5 fields, each made only of cron characters — not arbitrary words.
	return fields.length === 5 && fields.every((f) => /^[\d*/,-]+$/.test(f));
}

/**
 * Turn an interval token ("15m", "2h", "90m") or a full 5-field cron expression
 * into a cron schedule. Sub-minute intervals round up to one minute (cron's floor);
 * intervals that don't land on a clean cron step snap to the nearest one.
 */
export function parseInterval(input: string): ParsedInterval {
	const trimmed = input.trim();
	if (isFullCron(trimmed)) {
		return { cron: trimmed, description: `cron: ${trimmed}` };
	}

	const match = trimmed.match(/^(\d+)\s*(s|m|h|d)$/i);
	if (match) {
		const value = parseInt(match[1], 10);
		const unit = match[2].toLowerCase();
		const totalSec = value * (UNIT_SECONDS[unit] ?? 60);
		if (totalSec < 60) {
			return { cron: "*/1 * * * *", description: `${totalSec} seconds (rounded to 1 minute)` };
		}
		return snapToCommon(totalSec);
	}

	throw new Error(
		`Cannot parse interval "${input}". Use formats like "5m", "2h", "1d", or a full cron expression.`,
	);
}

/**
 * Pull an interval out of free-form command args, supporting both a leading bare
 * token ("15m do X") and a trailing clause ("do X every 2 hours"). Returns the
 * matched interval token (or null) and the remaining prompt text.
 */
export function extractInterval(args: string): { interval: string | null; prompt: string } {
	const trimmed = args.trim();

	// Leading bare token: "15m ...", "30s ...".
	const lead = trimmed.match(/^(\d+)\s*([smhd])\b\s*/i);
	if (lead) {
		return { interval: `${lead[1]}${lead[2].toLowerCase()}`, prompt: trimmed.slice(lead[0].length).trim() };
	}

	// Leading full cron: "*/5 * * * * ...".
	const cronLead = trimmed.match(/^((?:\S+\s+){4}\S+)\s+(.*)$/);
	if (cronLead && isFullCron(cronLead[1]) && /[*\d]/.test(cronLead[1])) {
		return { interval: cronLead[1], prompt: cronLead[2].trim() };
	}

	// Trailing clause: "... every 2 hours", "... every hour", "... every 30m".
	const trail = trimmed.match(/\bevery\s+(\d+)?\s*([a-z]+)\b\s*$/i);
	if (trail) {
		const unit = WORD_UNIT[trail[2].toLowerCase()] ?? (/^[smhd]$/i.test(trail[2]) ? trail[2].toLowerCase() : null);
		if (unit) {
			const value = trail[1] ? parseInt(trail[1], 10) : 1;
			return { interval: `${value}${unit}`, prompt: trimmed.slice(0, trail.index).trim() };
		}
	}

	return { interval: null, prompt: trimmed };
}

/** Compute the next wall-clock time a cron expression fires after `fromDate`. */
export function cronToNextFire(cronExpr: string, fromDate: Date): Date {
	const parts = cronExpr.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error(`Invalid cron expression: ${cronExpr}`);
	const [minF, hourF, dayF, monthF, dowF] = parts;

	const now = new Date(fromDate);
	now.setSeconds(0, 0);

	// Walk forward a minute at a time, up to a year, until all fields match.
	for (let i = 0; i < 525600; i++) {
		now.setMinutes(now.getMinutes() + 1);
		if (!cronFieldMatches(minF, now.getMinutes())) continue;
		if (!cronFieldMatches(hourF, now.getHours())) continue;
		if (!cronFieldMatches(dayF, now.getDate())) continue;
		if (!cronFieldMatches(monthF, now.getMonth() + 1)) continue;
		if (!cronFieldMatches(dowF, now.getDay())) continue;
		return new Date(now);
	}
	throw new Error(`No matching time found for cron expression: ${cronExpr}`);
}

export function cronFieldMatches(field: string, value: number): boolean {
	if (field === "*") return true;
	for (const part of field.split(",")) {
		if (part === "*") return true;

		if (part.includes("/")) {
			const [range, stepStr] = part.split("/");
			const step = parseInt(stepStr, 10);
			if (!step) continue;
			let rangeMin: number;
			let rangeMax: number;
			if (range === "*") {
				rangeMin = 0;
				rangeMax = 59;
			} else if (range.includes("-")) {
				const [lo, hi] = range.split("-");
				rangeMin = parseInt(lo, 10);
				rangeMax = parseInt(hi, 10);
			} else {
				continue;
			}
			for (let v = rangeMin; v <= rangeMax; v += step) {
				if (v === value) return true;
			}
			continue;
		}

		if (part.includes("-")) {
			const [lo, hi] = part.split("-");
			if (value >= parseInt(lo, 10) && value <= parseInt(hi, 10)) return true;
			continue;
		}

		if (parseInt(part, 10) === value) return true;
	}
	return false;
}

/**
 * Deterministic per-loop offset so multiple sessions don't hit the API at the
 * same wall-clock instant. Derived from the loop id, so a loop's offset is stable.
 */
export function computeJitter(loopId: string, recurring: boolean, scheduleMinutes: number): number {
	let hash = 0;
	for (let i = 0; i < loopId.length; i++) {
		hash = (hash << 5) - hash + loopId.charCodeAt(i);
		hash |= 0;
	}
	const normalized = Math.abs(hash % 10000) / 10000;
	if (recurring && scheduleMinutes <= 30) {
		return Math.floor(normalized * (scheduleMinutes / 2) * 60 * 1000);
	}
	if (recurring) {
		return Math.floor(normalized * 30 * 60 * 1000);
	}
	return Math.floor(normalized * 90 * 1000);
}
