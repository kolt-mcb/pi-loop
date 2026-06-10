# pi-loop

A [pi](https://github.com/earendil-works/pi) extension that runs a prompt **repeatedly** — on a fixed timer, when a pi event fires, or at the agent's own pace. Modelled on Claude Code's `/loop`.

## Overview

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/kolt-mcb/pi-loop/blob/main/LICENSE)
[![pi-package](https://img.shields.io/badge/pi-package-orange.svg)](https://pi.dev/packages)
[![Version](https://img.shields.io/badge/version-%40v0.4.0-blue.svg)](https://github.com/kolt-mcb/pi-loop/releases/tag/v0.4.0)

Schedule a prompt to run repeatedly inside pi — on a fixed timer, when a pi event fires, or **self-paced**, where the model itself continues the loop each turn and ends it by stopping.

## What changed in 0.4

Self-paced `/loop <prompt>` is now **model-driven**, faithfully matching Claude Code's `/loop`: the model does one iteration's work, then calls `schedule_loop_wakeup` at the end of its turn to run the next one — and ends the loop simply by **not** calling it (omit-to-end). There is no harness auto-continue.

One mechanism, three natural shapes:
- **Indefinite** — the model calls the wakeup every turn (e.g. *keep incrementing count.txt*).
- **Goal-bound** — it continues until the goal is met, then omits the call (e.g. *count to 10, then stop*).
- **Stochastic** — it continues an unpredictable number of times, stopping on a runtime condition (e.g. *roll a die until a 6*).

The path here is the point. Earlier 0.3.x versions removed the model's control entirely (harness auto-continue, indefinite-only) on the assumption a weaker local model couldn't drive the loop at all. That was too pessimistic — the earlier failures were mostly a *bad prompt*. With a clean, de-jargoned version of Claude Code's wakeup prompt, a local model drives all three shapes (validated by hand and by `npm run test:e2e`). The remaining caveat is honest: model-driven continuation still relies on the model calling the wakeup **and then ending its turn**, and a weaker model occasionally spins on the wakeup tool instead of stopping. If you need a loop that cannot stall, the cron form (`/loop 15m …`) is harness-driven and immune.

### 0.2.x–0.3.x foundations

0.2.0 made a parsed interval **authoritative and timer-driven** (`/loop 15m …` → cron on a self-re-arming timer), and added **event**/**hybrid** triggers, **multiple concurrent loops**, **persistence** across resume, per-session jitter, and a climbing iteration display.

## Features

- **Fixed-interval loops** — `/loop 15m <prompt>` parses the interval into cron and runs it on a self-re-arming timer. Continuation is the default.
- **Model-driven self-paced loops** — `/loop <prompt>` (no interval): the model does each iteration, then calls `schedule_loop_wakeup` to run the next one, or omits it to end the loop. Naturally handles indefinite, goal-bound, and stochastic loops. You can always take over (`/loop stop`, or just type).
- **Event & hybrid triggers** — fire on a pi event (e.g. `tool_execution_end`, `turn_end`, `monitor:done`) instead of polling, or combine cron + event with debounce.
- **Multiple loops** — run several at once; manage with `LoopCreate` / `LoopList` / `LoopDelete` or `/loop list`.
- **Persistence** — loops are stored under `.pi/loops` and restored, if unexpired, on `--resume`/`--continue`.
- **Safety caps** — per-loop `maxFires` and an automatic 7-day expiry; jittered fire times avoid API stampedes.
- **Read-only mode** — restrict a loop's fires to read/inspection tools.
- **Live status** — a footer indicator and widget list active loops with next-fire countdowns. A self-paced loop leads with its climbing iteration count (`⟳ #2 … · next in 0s`); the loop id is shown in `/loop list`.

## Installation

```bash
pi install npm:@koltmcbride/pi-loop
# or
pi install git:github.com/kolt-mcb/pi-loop@v0.4.0
```

Verify it's loaded with `pi list`.

## Quick start

```
/loop 5m check if the deployment finished and report what happened
```
Fixed 5-minute loop. Runs until you stop it, 7 days pass, or it hits a fire cap.

```
/loop check whether CI passed and address review comments
```
Self-paced: the model works an iteration, then continues by calling `schedule_loop_wakeup` — and stops on its own when the task is done (or you `/loop stop` / type to take over).

```
/loop stop          # stop all active loops
/loop stop 3        # stop loop #3
/loop list          # show / manage active loops
```

## Usage

### `/loop` command

| Input | Behaviour |
|---|---|
| `/loop 15m <prompt>` | Fixed-interval (cron) loop. Interval may also trail: `<prompt> every 2 hours`. |
| `/loop 0 9 * * 1-5 <prompt>` | Full 5-field cron schedule. |
| `/loop <prompt>` | Self-paced loop — the model continues each turn via `schedule_loop_wakeup`, and ends it by omitting the call (or you `/loop stop`). |
| `/loop list` | List/manage active loops. |
| `/loop stop [id]` | Stop all loops, or one by id. |

Intervals use `s` / `m` / `h` / `d`. Sub-minute rounds up to one minute (cron's floor); odd intervals like `7m` snap to the nearest clean cron step and the loop tells you what it picked.

### Tools (for the agent)

| Tool | What it does |
|---|---|
| `LoopCreate` | Schedule a loop on a cron timer, a pi event, or a hybrid of both. Supports `recurring`, `readOnly`, `maxFires`, `filter`. |
| `LoopList` | List loops with ids, triggers, fire counts, next-fire times. |
| `LoopDelete` | Delete a loop, or `action="pause"` to keep it without firing. |
| `schedule_loop_wakeup` | Continue a self-paced `/loop`: call at the end of a turn to run the next iteration (optional `delaySeconds`; `0` = immediately). Omit it to end the loop. |

Trigger types: `cron` (`5m`, `1h`, `0 9 * * 1-5`), `event` (any pi event-bus channel; lifecycle events `tool_execution_start/end`, `turn_start/end`, `agent_start/end`, `message_end` are bridged through), or `hybrid` (both, debounced).

## Behaviour notes

- **Cron fires wait for idle.** A tick that lands while the agent is mid-turn marks the loop **due** (shown in the status widget) instead of queueing a stale prompt; the fire is delivered fresh the moment the agent goes idle. Ticks landing while already due collapse into that one fire — so when turns run longer than the interval, the effective cadence is one fire per turn, and `fireCount` only counts fires the agent actually received.
- **Event fires land between turns.** An event/hybrid fire is delivered as a follow-up to the turn that caused it; a recurring fire is skipped while a message is already queued, so ticks never stack.
- **Takeover.** Typing while a self-paced loop is running ends it (you took over). Cron/event loops keep running across your messages until you `/loop stop` them.
- **Ending a self-paced loop.** The model ends it by *not* calling `schedule_loop_wakeup` at the end of a turn (omit-to-end) — so it can stop itself when a goal is met or a condition is hit. You can always end it immediately with `/loop stop [id]` or by typing. The continuation is recorded during the turn and the next iteration is armed at turn-end, so a `delay:0` call can't fire mid-turn and double up.
- **No catch-up.** If fires were missed while busy, the loop fires once when idle, not once per missed interval.
- **Session binding.** Loops arm at session start (a `--resume`d loop fires without you having to type first), and re-bind when the session changes (`/new`, fork), so a new session never inherits the old session's timers. Note each session has its own store — a loop started in one terminal isn't visible to `/loop stop` in another.

## Configuration

| Variable | Effect | Default |
|---|---|---|
| `PI_LOOP` | `off` disables persistence (in-memory only); an absolute or relative path sets a custom store file | `.pi/loops/loops-<sessionId>.json` |

Constants at the top of `loop.ts` / `src/`: status tick interval, default hybrid debounce, and the bridged lifecycle event list. Caps: 25 active loops, 7-day expiry.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx — covers parsing, cron, jitter
```

Source layout:

| File | Responsibility |
|---|---|
| `src/types.ts` | Loop/trigger types. |
| `src/loop-parse.ts` | `parseInterval`, `extractInterval`, cron math, jitter (pure, tested). |
| `src/store.ts` | Loop registry + JSON persistence. |
| `src/scheduler.ts` | Self-re-arming cron timers. |
| `src/triggers.ts` | Event/hybrid subscriptions + debounce. |
| `loop.ts` | Entry: command, tools, fire→message bridge, status widget, lifecycle. |

## License

[MIT](LICENSE)
