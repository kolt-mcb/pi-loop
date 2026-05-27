# pi-loop

A [pi](https://github.com/earendil-works/pi) extension that runs a prompt or slash-command **repeatedly**, modelled on Claude Code's `/loop`.

## Overview

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/kolt-mcb/pi-loop/blob/main/LICENSE)
[![pi-package](https://img.shields.io/badge/pi-package-orange.svg)](https://pi.dev/packages)
[![Version](https://img.shields.io/badge/version-%40v0.1.0-blue.svg)](https://github.com/kolt-mcb/pi-loop/releases/tag/v0.1.0)

Automate repetitive workflows inside pi by scheduling a prompt or command to run on an interval or at the agent's own pace — with a live status indicator and automatic user yield.

## Features

- **Interval mode** — fire a payload every `N` seconds, minutes, or hours
- **Self-paced mode** — let the agent decide when to continue via a built-in tool
- **Live countdown** — footer status bar shows time remaining and iteration count
- **User yield** — typing any message instantly cancels the loop and passes control to you
- **Safety caps** — automatic termination after 100 iterations or 3 consecutive no-ops
- **Slash-expansion** — interval payloads that begin with `/` are expanded as pi commands

## Installation

From npm:

```bash
pi install npm:@kolt-mcb/pi-loop
```

From git:

```bash
pi install git:github.com/kolt-mcb/pi-loop@v0.1.0
```

This clones/downloads the package and registers it in your global settings. Use `-l` to install into project-local settings (`.pi/settings.json`) instead.

Verify it's loaded:

```bash
pi list
```

## Quick Start

Run tests every 5 minutes:

```
/loop 5m /run-tests
```

Tell the agent to self-correct continuously:

```
/loop keep refining until the code is production-ready
```

Stop any active loop at any time:

```
/loop stop
```

## Usage

### Interval Mode

Append a duration token (`s`, `m`, or `h`) before the payload:

| Syntax                | Meaning                        |
|-----------------------|--------------------------------|
| `/loop 30s say hello` | Run `say hello` every 30 seconds |
| `/loop 5m /run-tests` | Run `/run-tests` every 5 minutes |
| `/loop 2h deploy`     | Run `deploy` every 2 hours     |

When no unit is specified the number is treated as seconds (`/loop 60 check health`).

### Self-Paced Mode

Omit the duration token to let the agent control the loop cadence:

```
/loop poke the refactoring until it passes CI
```

The agent calls a `schedule_loop_wakeup` tool at the end of each turn to request another iteration. Cycle again or stop whenever.

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

| Setting              | Default | Description                                    |
|----------------------|---------|------------------------------------------------|
| `MAX_ITERATIONS`     | `100`   | Absolute safety cap; the loop self-terminates  |
| `MAX_NO_TURN`        | `3`     | Stop after this many turnovers that start no turn |
| `MIN_INTERVAL_MS`    | `1000`  | Minimum interval in milliseconds               |
| `TURN_START_TIMEOUT` | `10s`   | How long to wait for a fired turn to begin     |

These are compiled into the extension source. Adjust at the top of `loop.ts` as needed.

## Known Limitations

- **Single loop only** — only one loop is active at any given time.
- **No persistence** — loops do not survive restarts or session switches; they are cancelled on shutdown.
- **Floor intervals** — the interval is a minimum gap. Turns that exceed the period serialize because the loop only fires while the agent is idle.

## How It Works

The extension uses only pi's public API:

1. `pi.sendUserMessage()` re-fires the payload each iteration, with full slash-command expansion.
2. `ctx.isIdle()` / `ctx.waitForIdle()` gate firing; due to retries and auto-compaction splitting logical turns into several segments, the extension waits for idle to *settle* rather than trusting a single `agent_end` event.
3. Self-paced mode registers a `schedule_loop_wakeup` tool the agent invokes to request another iteration.
4. The `input` event handler detects `source === "interactive"` to yield control when the user types, while ignoring the loop's own re-fires (`source: "extension"`).
5. A 1-second `setInterval` ticker drives the footer countdown via `ctx.ui.setStatus()`.

## License

[MIT](LICENSE)
