# pi-loop

A [pi](https://github.com/earendil-works/pi) extension that runs a prompt **repeatedly** — on a fixed timer, when a pi event fires, or at the agent's own pace. Modelled on Claude Code's `/loop`.

## Overview

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/kolt-mcb/pi-loop/blob/main/LICENSE)
[![pi-package](https://img.shields.io/badge/pi-package-orange.svg)](https://pi.dev/packages)
[![Version](https://img.shields.io/badge/version-%40v0.3.2-blue.svg)](https://github.com/kolt-mcb/pi-loop/releases/tag/v0.3.2)

Schedule a prompt to run repeatedly inside pi. Whether driven by a timer or by the agent itself, **the model is never responsible for keeping a loop alive** — the harness re-fires it, and it stops only on an explicit signal.

## What changed in 0.3

Self-paced `/loop <prompt>` is now **auto-continuing and runs indefinitely**: after every turn the harness re-fires it on its own, and **only the user ends it** — `/loop stop`, or typing anything (a takeover). The model cannot end a user-started loop: it is told not to, and `LoopDelete` on a `/loop` is refused. Previously the model had to call a wakeup tool at the *end of every turn* or the loop silently died — a protocol weaker models (and a turn that ends on a summary) routinely dropped; worse, even after auto-continue landed, a hint inviting the model to "stop when the goal is reached" made it quit open-ended tasks ("this is infinite, so I'll stop").

This mirrors how Codex / Claude Code agent loops behave: **continuation is the default; the human decides when it's done.** The model's loop-control surface for a user `/loop` is removed entirely — it can't stop it (`LoopDelete` refused), can't pace it, and can't reschedule it (`schedule_loop_wakeup` is a no-op). Weaker models otherwise fixate on those tools (pacing to 5min, or spamming a wakeup) instead of doing the task. Cadence is the user's, via `PI_LOOP_CONTINUE_MS`.

### 0.2.x foundations

0.2.0 made a parsed interval **authoritative and timer-driven** (`/loop 15m …` → cron on a self-re-arming timer), and added **event**/**hybrid** triggers, **multiple concurrent loops**, and **persistence** that restores unexpired loops on resume.

## Features

- **Fixed-interval loops** — `/loop 15m <prompt>` parses the interval into cron and runs it on a self-re-arming timer. Continuation is the default.
- **Auto-continuing loops** — `/loop <prompt>` (no interval) fires, then the harness re-fires it after each turn on its own (default 5s gap, set `PI_LOOP_CONTINUE_MS`), indefinitely. Only the user ends it (`/loop stop`, typing/takeover, or `maxFires`/expiry); the model cannot stop a user-started loop. The status widget shows a live `next in …` countdown to each auto-iteration.
- **Event & hybrid triggers** — fire on a pi event (e.g. `tool_execution_end`, `turn_end`, `monitor:done`) instead of polling, or combine cron + event with debounce.
- **Multiple loops** — run several at once; manage with `LoopCreate` / `LoopList` / `LoopDelete` or `/loop list`.
- **Persistence** — loops are stored under `.pi/loops` and restored, if unexpired, on `--resume`/`--continue`.
- **Safety caps** — per-loop `maxFires` and an automatic 7-day expiry; jittered fire times avoid API stampedes.
- **Read-only mode** — restrict a loop's fires to read/inspection tools.
- **Live status** — a footer indicator and widget list active loops with next-fire countdowns, including the `next in …` time before an auto-continuing loop's next iteration.

## Installation

```bash
pi install npm:@koltmcbride/pi-loop
# or
pi install git:github.com/kolt-mcb/pi-loop@v0.3.2
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
Auto-continuing: the model works, the harness re-fires after each turn, and it keeps going until *you* stop it (`/loop stop` or just typing).

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
| `/loop <prompt>` | Auto-continuing loop — re-fires after each turn and runs indefinitely until *you* stop it (`/loop stop` or typing). |
| `/loop list` | List/manage active loops. |
| `/loop stop [id]` | Stop all loops, or one by id. |

Intervals use `s` / `m` / `h` / `d`. Sub-minute rounds up to one minute (cron's floor); odd intervals like `7m` snap to the nearest clean cron step and the loop tells you what it picked.

### Tools (for the agent)

| Tool | What it does |
|---|---|
| `LoopCreate` | Schedule a loop on a cron timer, a pi event, or a hybrid of both. Supports `recurring`, `readOnly`, `maxFires`, `filter`. |
| `LoopList` | List loops with ids, triggers, fire counts, next-fire times. |
| `LoopDelete` | Delete a loop, or `action="pause"` to keep it without firing. |
| `schedule_loop_wakeup` | No-op for a user `/loop` (kept only so a stray call doesn't error). A `/loop`'s cadence is the user's, set via `PI_LOOP_CONTINUE_MS` — the model can't pace or reschedule it. |

Trigger types: `cron` (`5m`, `1h`, `0 9 * * 1-5`), `event` (any pi event-bus channel; lifecycle events `tool_execution_start/end`, `turn_start/end`, `agent_start/end`, `message_end` are bridged through), or `hybrid` (both, debounced).

## Behaviour notes

- **Cron fires wait for idle.** A tick that lands while the agent is mid-turn marks the loop **due** (shown in the status widget) instead of queueing a stale prompt; the fire is delivered fresh the moment the agent goes idle. Ticks landing while already due collapse into that one fire — so when turns run longer than the interval, the effective cadence is one fire per turn, and `fireCount` only counts fires the agent actually received.
- **Event fires land between turns.** An event/hybrid fire is delivered as a follow-up to the turn that caused it; a recurring fire is skipped while a message is already queued, so ticks never stack.
- **Takeover.** Typing while an **auto-continuing** loop is running ends it (you took over). Fixed and event loops keep running across your messages until you `/loop stop` them.
- **Stopping an auto-continuing loop is the user's job.** It runs indefinitely — `/loop stop [id]` ends it, and typing anything is a takeover that ends it too. The model is explicitly told not to stop a user-started loop, and `LoopDelete` against a `/loop` is refused (it stays running). This is deliberate: a model that decides an open-ended task is "done" must not be able to kill your loop. (Loops the *model* created via `LoopCreate` remain model-deletable — the guard is scoped to user-started `/loop`s.)
- **No catch-up.** If fires were missed while busy, the loop fires once when idle, not once per missed interval.
- **Session binding.** Loops arm at session start (a `--resume`d loop fires without you having to type first), and re-bind when the session changes (`/new`, fork), so a new session never inherits the old session's timers. Note each session has its own store — a loop started in one terminal isn't visible to `/loop stop` in another.

## Configuration

| Variable | Effect | Default |
|---|---|---|
| `PI_LOOP` | `off` disables persistence (in-memory only); an absolute or relative path sets a custom store file | `.pi/loops/loops-<sessionId>.json` |
| `PI_LOOP_CONTINUE_MS` | Gap before an auto-continuing `/loop <prompt>` re-fires after a turn ends | `5000` |

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
