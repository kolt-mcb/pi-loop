# pi-loop

A [`pi`](https://github.com/earendil-works/pi) coding-agent extension that runs a prompt or slash-command **repeatedly**, modelled on Claude Code's `/loop`.

## Modes

| Command | Behaviour |
|---|---|
| `/loop 5m /run-tests` | **Interval** — re-fires the payload every 5 minutes |
| `/loop 30s say hi` | Interval with a plain prompt (`s`/`m`/`h`, bare number = seconds) |
| `/loop keep fixing lint` | **Self-paced** — the agent decides when to continue by calling the `schedule_loop_wakeup` tool; the loop ends as soon as it stops calling it |
| `/loop stop` (or `/loop off`) | Stop the active loop |
| `/loop` | Show status / usage |

## Usage

### Install as a pi package (recommended)

This repo ships a `pi` manifest (`package.json` → `pi.extensions`), so it installs with the package manager and updates via `pi update`:

```bash
pi install git:github.com/grunt3714-lgtm/pi-loop@v0.1.0
```

This writes the package to `~/.pi/agent/settings.json` and clones it to `~/.pi/agent/git/`. Use `-l` to install into project settings instead. Manage with `pi list`, `pi update`, and `pi remove git:github.com/grunt3714-lgtm/pi-loop`.

### Alternatives

```bash
# Copy the single file into the extensions dir for auto-discovery
cp loop.ts ~/.pi/agent/extensions/        # global
cp loop.ts .pi/extensions/                # project-local

# Try it for one run without installing
pi --extension /path/to/pi-loop/loop.ts
```

> Don't combine the package install with a loose `extensions/loop.ts` copy — both would load and you'd get a duplicate `/loop` command (`/loop` and `/loop:1`).

## Notes & limitations

- Only **one** loop runs at a time.
- Loops do **not** survive a restart or a session switch (they are cancelled on `session_start`/`session_shutdown`).
- The loop **yields automatically** when you type your own message — your input cancels it.
- The interval is a **floor**, not a guarantee: a turn longer than the period serializes, since an iteration only fires while the agent is idle.
- A 100-iteration safety cap stops a runaway loop.
- It stops itself if a turn fails to start **3 times in a row** (e.g. no model/API key configured), so a misconfigured session doesn't spin silently.
- While active, the footer shows a **live countdown** to the next iteration (e.g. `⟳ loop · next in 4m12s · iter 3`), or `running` during a turn.

## How it works

The extension is built entirely on pi's public extension API:

- `pi.sendUserMessage(payload, { executeSlashCommands: true })` re-fires the payload each iteration, expanding a leading `/command` exactly like interactive input.
- `pi.withCommandContext(...)` synthesises a command context from the timer/tool callbacks (which otherwise have none).
- `ctx.isIdle()` / `ctx.waitForIdle()` gate firing and detect turn completion. Because retries and auto-compaction split one logical turn into several agent-run segments, the extension waits for idle to *settle* rather than trusting a single `agent_end`.
- Self-paced mode registers a `schedule_loop_wakeup` tool the agent calls to request another iteration.
- The `input` event yields to the user — filtered to `source === "interactive"` so the loop's own re-fires (`source: "extension"`) don't cancel it.
- A 1-second ticker updates the footer countdown via `ctx.ui.setStatus()`; it's `unref`'d (never blocks exit) and no-ops without a UI.

## License

MIT
