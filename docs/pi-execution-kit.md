# Managed Pi execution kit

This document describes `AGENT_RUNTIME=pi`, the managed isolation boundary.
[Trusted-local development](local-development.md) uses `AGENT_RUNTIME=pi-local`
and the user's native Pi installation instead. Its host authority is explicit;
it does not claim the isolation, sealed tools or provider brokering described here.

Rakazo keeps a continuous conversation per bot. Isolated Pi coding-agent RPC workers own execution context; Rakazo owns authorization, credentials, durable user intent, and external-effect reconciliation. Workers may stop or restart without replacing the logical conversation.

## Architecture

- `packages/pi-kit` pins Pi and content-addressed Fabric, Fovea, queue-steer, retry, multiprovider, and hide-providers archives. Startup validates installed identities. Runtime never installs extensions or resolves sibling checkouts.
- The supervisor launches an unprivileged, networkless worker with a read-only image, bounded scratch space, and one private bridge socket. Computer files and credentials are not mounted into that worker.
- Backend model and tool brokers preserve connection ownership, computer placement, approval latches, and run leases. Fabric core overrides never fall back to host tools. Managed provider authority stays sealed across reloads.
- Fovea indexes bounded, authorized computer snapshots. Explicit roots retain isolated observation state; project configuration and plugins are not loaded from those snapshots.
- Runtime sessions retain Pi source entries, compaction boundaries, child transcripts, and stable participant identity separately from product messages. Clearing a thread fences old work and removes its queue, placement, and runtime state.

## Model tools and native providers

Only `fabric_exec` is sent to a model. Tool-free compaction is allowed; the backend rejects standalone or duplicate tool schemas before provider routing. Captured tools cannot reactivate a second model-facing surface.

- `pi.*` exposes the authorized computer operations. Implementation callbacks such as `read_file`, `shell` and `run_subagent` are private, not duplicate `extensions.*` tools.
- `agents.*` uses the shared Fabric agent service through a caller-bound private bridge. Fabric owns admission, lineage, lifecycle, structured results and snapshots; Rakazo authorizes model, placement and effects and drives isolated Pi participants. Explicit resume reauthorizes retained participants. Opaque checkpoints never appear in model-facing agent records.
- `memory.*` uses native Fabric providers over the exact participant checkpoint and, where authorized, the backend conversation archive. There is no separate substring-search or expansion engine.
- `mcp.*` uses Fabric's MCP provider over authorized server/tool metadata and broker callbacks, including actual MCP installations. Credentials, transport setup and live authorization remain backend-owned. Fabric receives full authorized schemas rather than a second search/load/execute catalog. Server registration and ambient configuration are unavailable inside workers.
- `extensions.*` retains genuine product capabilities and Fovea. Durable bot dispatch, queue control, attachments, scratchpad CRUD and optional semantic-memory writes/search are not substitutes for Fabric's agent or exact-recall primitives.

Ambient actors/mesh/residency, local execution runtimes and automatic worktree creation are unavailable in managed workers. Compaction requests remain idle-boundary product intents; Fabric performs the actual deterministic compaction. Unsupported capabilities fail closed instead of accessing the worker host.

## Queue and inspection

One shared headless queue engine owns FIFO order, lanes, holds, edit sessions, dispatch reservations, and recovery. PostgreSQL commits reservations before delivery; uncertain delivery remains held for explicit reconciliation. The native Pi queue is not reconstructed from a second editable plan.

Web/Electron and mobile use the same queue and execution controllers. `extensions.manage_queue` exposes revision-checked natural-language control of the current private bot queue; external messaging runs, inbound webhooks, and children cannot read or mutate that private plan.

Queued work captures an immutable authorized computer/project binding. Missing or changed targets block rather than silently switching directories. Existing worktrees are selected with `cwd`; automatic `worktree: true` creation is explicitly rejected. Create a worktree through the authorized shell tool, then delegate to its explicit path.

A graceful pause parks the live turn at the next safe boundary and stamps the parked turn into the durable queue state under the run's lease. Resume of that parked turn records an explicit durable intent and wakes exactly one fenced continuation run with a fixed prompt; acknowledged queue rows are never replayed, and an empty queue resumes the parked turn itself. Session generation, ownership, or placement drift leaves the intent held with an actionable rejection instead of silently discarding it or restoring a stale checkpoint. Continuation restores the last saved runtime checkpoint only — there is no full replay guarantee for work the runtime had not committed at the pause boundary. Graceful pause waits for authorized effects to reach a safe boundary, suspends children before their parent, and saves their checkpoints before releasing the root lease. Explicit child stop cancels only that participant; uncertain effects are never automatically replayed.

Flow is a projection of retained delegation, execution, messaging, continuation, and wait evidence—not a second workflow language. Historical events without source or outputs remain incomplete. Inspection and related-run discovery are scoped and bounded.

## Compaction, retry, and routing

After an eligible idle period, Fabric deterministically compacts before the next model request without a model summarization call. Source remains addressable through exact recall. An unchanged-source fingerprint prevents repeated compaction. This reduces cold-prefill volume; it does not promise a cache hit.

Retry activity and cancellation are retained. Final broker failures stop worker retries: an exhausted request must not be replayed by another retry owner. Same-provider credential pools use multiprovider; different models/providers require explicit fallback targets. Fallback never replays after output starts. Scheduler health is bounded process-local state; restarting a backend resets that health, not the saved routing policy. Credentials remain backend-only.

## Bot memory across conversations

Fabric provides explicit source-backed `memory.recall`, `memory.expand`, `memory.sessions`, and guest `memory.walk` primitives through its lightweight `pi-fabric/memory` entry. It does not decide which conversations a bot may read or automatically inject memories.

Rakazo binds a backend source to the current space, owner, bot, and destination thread. Eligible private root runs can search the bot's retained DM and same-owner groups where it is still a member. Group turns receive one bounded, source-linked selection of relevant prior assistant work; exact retrieval stays available on demand. No `remember` call, live worker, or optional hosted memory service is required for retained conversation output.

Every source read revalidates access. Foreign owners, bots and spaces, removed group membership, archived conversations, deleted messages, and cleared history do not gain access through cached pointers. Helpers, dispatched workers, external messaging and webhook-triggered runs do not inherit bot-wide archive authority. Without archive authority, only the participant's native session source is registered. Explicit `source: "managed-session"` and session-scoped retrieval stay local; archive-qualified pointers remain backend-authorized. Local recall uses the same Fabric normalization, structural search, integrity-bound expansion and pagination as other sources, preserving original entries and the selected live branch.

This is retained conversation memory, not a promise of complete lifetime capture. The source exposes sanitized product-visible evidence, not opaque checkpoints, private reasoning, credentials, or arbitrary tool state. The initial archive window prioritizes the latest 400 messages per conversation, up to 25 other group memberships, with per-message and total-text bounds. Enumeration and projection limits remain visible in coverage; this is not a complete lifetime index, and a missing result is not evidence that work never happened. Web, Electron and mobile share this backend behavior without additional status chrome.

## Model visibility

Advanced model settings share one account-scoped preference across web, Electron, and mobile: `models.getVisibility()` and `models.setVisibility({ hide: [{ provider, model? }] })`. Omitting `model` hides a whole provider. `models.listForVisibility()` returns the existing public catalog for hide/unhide controls; ordinary `models.list()` excludes hidden entries. Rules use exact, case-sensitive canonical identities, with at most 100 rules, 100-character providers, and 300-character model IDs. Wildcards are rejected rather than passing network input to upstream's backtracking glob matcher.

Hiding is reversible preference, not credential revocation. It neither deletes connections nor rewrites saved model pins. A pin that becomes hidden remains the requested model and reports an actionable unhide/change failure. Backend selection, worker delegation, and request/fallback validation use the owning user's preference; there is no global API registry patch or project-config override. Changes apply before the next model request, not retroactively to an in-flight response.

The pinned `pi-hide-providers` 0.1.18 TypeScript extension loads through Pi's SDK in each isolated worker. Its config context is restricted to fresh host-owned scratch, and the host replaces `/hide-models` with a settings-only error before binding so worker-local add/remove/reset commands cannot claim to change account preferences. That empty local config is intentional: workers see `rakazo-broker`, not real provider identities. Canonical backend checks—not the extension's notification-only `model_select` handler—enforce account visibility. Unmanaged upstream behavior is tested separately against its packaged predicate and actual headless lookup/list hooks.

## Distribution and checks

Use Node 24 LTS (or a supported newer even-numbered release) and the repository's pinned Bun version (package manager only; Pi still runs on Node).

- `bun run pi:kit:check`: validate installed identities and archive integrity/public exports.
- `bun run sandbox:build`: build both the computer and isolated agent images for local development.
- Compose builds or selects the matching agent image automatically. Production updates include the supervisor. Existing deployments must recreate the updater when adopting this topology so its service list includes the supervisor.
- `bun run pi:kit:vendor`: developer-only archive refresh after building and testing the sibling packages; update the lockfile and pinned identities together. Use `bun run pi:kit:vendor --only pi-hide-providers` to refresh only that archive and preserve all other hashes.

## Acceptance ledger

| Boundary | Evidence / remaining verification |
| --- | --- |
| Recursive cwd, inherited capabilities, and Fovea root continuity | Sibling conformance tests and fresh builds passed; packaged into the kit |
| Shared queue state and write-ahead acknowledgment | Offline tests and real PostgreSQL concurrency/recovery probes passed |
| Managed Fabric, all eight core overrides, Fovea snapshots, exact recall, and deterministic idle compaction | Installed-kit conformance probes passed |
| Same-provider rotation and explicit fallback | Scheduler tests and real offline SDK/HTTP probes passed |
| Account model visibility | Exact-rule safety, authenticated owner/catalog isolation, hidden pin/worker/fallback rejection, and extracted upstream headless/conformance probes passed; clean-install six-package resolution, artifact checks, and actual managed-kit headless loading passed |
| Shared queue/Flow/routing UI | App type checks, controller tests, browser control probes, and CI screenshot-test registration passed |
| Clean installation and migrations | Standalone kit resolution and clean PostgreSQL migration deployment passed |
| Atomic secret-preserving edits and delegation reservations | Raw-byte, concurrent-process, approval-boundary, reservation-race, and actual-executor PostgreSQL probes passed |
| Targeted participant queue controls and reviewed commands/gates | Real RPC child steering, retained images/source identity, compact acknowledgment, and non-deadlocking gate probes passed |
| Whole runtime acceptance | Full offline regression, all 23 workspace checks, all 20 isolated PostgreSQL suites, actual RPC/file persistence, and explicit paused-turn continuation probes passed |
| Production container enforcement and full-stack screenshots | Docker smoke and screenshot execution remain CI checks; local Docker daemon unavailable; Electron E2E intentionally not run |
