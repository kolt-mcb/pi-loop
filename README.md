# pi-loop

A [pi](https://github.com/earendil-works/pi) extension that runs a prompt or slash-command **repeatedly**, modelled on Claude Code's `/loop`.

## Overview

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/kolt-mcb/pi-loop/blob/main/LICENSE)
[![pi-package](https://img.shields.io/badge/pi-package-orange.svg)](https://pi.dev/packages)
[![Version](https://img.shields.io/badge/version-%40v0.1.8-blue.svg)](https://github.com/kolt-mcb/pi-loop/releases/tag/v0.1.8)

Automate repetitive workflows inside pi by scheduling a prompt or command to run on an interval or at the agent's own pace — with a live status indicator and automatic user yield.

## Features

- **Self-paced loop** — the agent decides whether (and when) to continue each turn via a built-in `schedule_loop_wakeup` tool; pass a cadence in plain language and the model schedules the delay
- **Live countdown** — footer status bar shows time remaining and iteration count
- **User yield** — typing any message instantly cancels the loop and passes control to you
- **Safety caps** — automatic termination after 100 iterations or 3 consecutive no-ops
- **Slash-expansion** — payloads that begin with `/` are expanded as pi commands

## Installation

From npm:

```bash
pi install npm:@koltmcbride/pi-loop
```

From git:

```bash
pi install git:github.com/kolt-mcb/pi-loop@v0.1.8
```

This clones/downloads the package and registers it in your global settings. Use `-l` to install into project-local settings (`.pi/settings.json`) instead.

Verify it's loaded:

```bash
pi list
```

## Quick Start

Run tests roughly every 5 minutes (the agent schedules the gap):

```
/loop every 5 minutes run the tests and fix any failures
```

Tell the agent to self-correct continuously, as fast as it can:

```
/loop keep refining until the code is production-ready
```

Stop any active loop at any time:

```
/loop stop
```

## Usage

Everything after `/loop` is the payload, sent to the agent verbatim each iteration. There is a single self-paced mode: the agent decides whether to continue and how long to wait by calling the built-in `schedule_loop_wakeup` tool at the end of its turn. If it omits the call, the loop ends.

### Cadence

Express the interval in plain language inside the payload — the model interprets it and passes a `delaySeconds` to the tool:

| Syntax                                       | Behaviour                                  |
|----------------------------------------------|--------------------------------------------|
| `/loop every 30 seconds say hello`           | Agent reschedules ~30s after each turn     |
| `/loop every 5 minutes run /run-tests`       | Agent reschedules ~5m after each turn      |
| `/loop keep going until CI is green`         | No delay — re-fires as soon as it's idle   |

The interval is a floor, not a guarantee: it is the delay the agent *requests* after a turn finishes, so turns longer than the interval simply serialize. A payload beginning with `/` (e.g. `run /run-tests`) is expanded as a pi slash-command.

### Status and Control

| Command           | Action                                       |
|-------------------|----------------------------------------------|
| `/loop`           | Show current status or usage help            |
| `/loop stop`      | Stop the active loop                         |
| `/loop off`       | Alias for `stop`                             |

### Alternatives

```bash
# Copy for auto-discovery (global scope)
cp loop.ts ~/.pi/agent/extensions/

# Copy for auto-discovery (project scope)
cp loop.ts .pi/extensions/

# Test one-shot without installing
pi --extension /path/to/pi-loop/loop.ts
```

> **Avoid duplication** — don't combine the package install with a loose `extensions/loop.ts` copy. Both locations load, producing a conflicting `/loop:1` command.

## Live Status

While a loop is active, the pi footer displays a real-time countdown:

```
⟳ loop · next in 4m12s · iter 3 done
#             or during an in-flight turn:
⟳ loop · running · iter 4
```

## Configuration

| Setting          | Default  | Description                                             |
|------------------|----------|---------------------------------------------------------|
| `MAX_ITERATIONS` | `100`    | Absolute safety cap; the loop self-terminates           |
| `MAX_NO_TURN`    | `3`      | Stop after this many iterations that start no turn      |
| `IDLE_SETTLE_MS` | `200`    | Settle gap across retry/compaction segments before re-firing |
| `TICK_MS`        | `1000`   | Footer countdown refresh interval                       |

These are constants at the top of `loop.ts`. Adjust as needed. (The 10s wait for a fired turn to begin is hardcoded in `waitForTurnStart`.)

## Known Limitations

- **Single loop only** — only one loop is active at any given time.
- **No persistence** — loops do not survive restarts or session switches; they are cancelled on shutdown.
- **Floor intervals** — the interval is a minimum gap. Turns that exceed the period serialize because the loop only fires while the agent is idle.

## How It Works

The extension uses only pi's public API:

1. `pi.sendUserMessage()` re-fires the payload each iteration, with full slash-command expansion.
2. `ctx.isIdle()` / `ctx.waitForIdle()` gate firing; due to retries and auto-compaction splitting logical turns into several segments, the extension waits for idle to *settle* rather than trusting a single `agent_end` event.
3. A `schedule_loop_wakeup` tool is registered for the agent to invoke (with an optional `delaySeconds`) to request another iteration; not calling it ends the loop.
4. The `input` event handler detects `source === "interactive"` to yield control when the user types, while ignoring the loop's own re-fires (`source: "extension"`).
5. A 1-second `setInterval` ticker drives the footer countdown via `ctx.ui.setStatus()`.

## License

[MIT](LICENSE)
