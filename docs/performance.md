# Desktop performance benchmarks

Rakazo measures the production Vite renderer inside a packaged Electron directory build against a
disposable Postgres database, the scripted agent runtime, and the fake sandbox. No provider account
or production data is used.

Run a baseline from a local Conductor workspace with Docker available:

```sh
bun run perf:desktop --label=before
```

The command uses `CONDUCTOR_PORT` and the next allocated port for its web and API servers. Reports
are written to `.context/performance/<label>.json` and `.md`, which remain local to the workspace.
Override the number of cold and warm launch samples when iterating:

```sh
bun run perf:desktop --label=quick --samples=2
```

To compare packaged assets with remote asset loading under a deterministic network delay:

```bash
bun run perf:desktop --label=remote-80ms --asset-delay=80 --remote-renderer
bun run perf:desktop --label=bundled-80ms --asset-delay=80 --skip-build
```

On macOS, compare destroy/recreate against the retained warm window with:

```bash
bun run perf:desktop --label=reopen-destroyed --disable-warm-window
bun run perf:desktop --label=reopen-retained --skip-build
```

After changing one performance-sensitive behavior, record another report and compare them:

```sh
bun run perf:desktop --label=after
bun run perf:compare .context/performance/before.json .context/performance/after.json
```

## Definitions

- **Cache-cold launch** uses a fresh copy of an authenticated profile and clears Chromium's HTTP and
  code caches before navigation. It is not an OS-filesystem cold start.
- **Warm launch** fully quits and relaunches Electron while preserving the primed profile and caches.
- **Shell usable** means authenticated bots and the active 100-message thread have committed and
  painted.
- **Settings painted/settled** separates React content paint from the end of the panel transition.
- **Typing** records keydown to the next animation frame with a 100-message transcript mounted.
- **Idle CPU/memory** samples every second for 12 seconds. Summed working-set memory is retained
  alongside raw per-process samples; Chromium working sets can double-count shared pages.
- **Streaming** drives the real subscription/reducer path with scripted progress every 50 ms.

Runtime CPU and launch measurements are informational until enough samples exist on a fixed Mac.
Bundle sizes are deterministic enough for automated regression checks. Keep hardware, platform, and
build mode fixed. A comparison that intentionally changes Electron or renderer mode measures the
combined migration result; it cannot attribute the change to either layer in isolation.

## Chat responsiveness and Linux compositors

Opening a thread reads an authorized database snapshot and subscribes from its durable cursor;
it does not launch Pi RPC. Agent startup is a separate execution path. Keep these measurements
separate: thread request/response/paint, then send-to-first-progress on a cold and restored run.
Do not prewarm privileged agent processes simply to make navigation faster.

The browser and Electron keep event reduction and cursors synchronous, but coalesce streamed snapshot
paints to one per animation frame. Explicit refreshes, history prepends, navigation and
primary run status changes publish immediately.
The frame publisher regression drives a thousand updates before a paint and expects one latest
publication; it is a work-count check, not a hardware latency claim. Restored managed workers use
set membership for message IDs while keeping the existing ordered JSON-array checkpoint format.

Sidebar and settings width changes no longer animate layout on every frame. Thread and panel
entry use short opacity/transform motion, disabled for reduced motion. Pending thread placeholders
wait briefly before appearing; fast reads should not flash a loader. No motion library is needed.

For Omarchy/Hyprland, compare the same **packaged build**, server, thread and workload, fully
quitting between launches (the single-instance lock otherwise reuses the existing process):

```sh
rakazo --ozone-platform=wayland
rakazo --ozone-platform=x11
```

The second command requires XWayland. Compare typing, streaming, scrolling and panel toggles,
not just startup. Record whether the difference occurs only while streaming or also in an idle
thread, along with Electron version, display scaling/refresh rate and compositor version. Keep
screenshots and performance reports free of real conversations, credentials and account data.

Rakazo does not currently force an Ozone backend or disable hardware acceleration. A compositor
or GPU-driver cause remains unverified until reproduced on the affected Linux setup. Do not ship
`--disable-gpu`, sandbox overrides or speculative Chromium flags as default performance fixes.
The desktop benchmark opens real windows; use browser regressions and desktop unit tests locally
unless explicitly running a desktop profiling session.

## Long-transcript and startup work bounds

Activity projection preserves message identity when no blocks are filtered, so an unchanged
historical row can actually use React's message memo. Peer and speech callbacks remain stable;
only a changed row or changed control state needs its message view rendered. Activity aggregation
uses indexes instead of scanning every accumulated link, and anchor restoration uses a set instead
of repeatedly searching the rendered transcript. This projection is shared with native mobile.

The regression suite covers two thousand retained rows, five thousand distinct peers with repeated
receipts, and two thousand activity-only anchors. Synthetic before/after probes verified identical
projected output; timings are informational, not a claim about a particular compositor or device.

Routine and connector metadata for mentions is requested only when the user starts an `@` mention.
Bot and group options are already available from navigation. This removes the eager per-bot routine
fan-out and connector catalog request from startup without caching authorized thread snapshots or
weakening refresh/replay behavior.
