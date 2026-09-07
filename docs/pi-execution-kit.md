# Managed Pi execution kit

Rakazo keeps a continuous conversation per bot. Isolated Pi coding-agent RPC workers own execution context; Rakazo owns authorization, credentials, durable user intent, and external-effect reconciliation. Workers may stop or restart without replacing the logical conversation.

## Architecture

- `packages/pi-kit` pins Pi and content-addressed Fabric, Fovea, queue-steer, retry, and multiprovider archives. Startup validates installed identities. Runtime never installs extensions or resolves sibling checkouts.
- The supervisor launches an unprivileged, networkless worker with a read-only image, bounded scratch space, and one private bridge socket. Computer files and credentials are not mounted into that worker.
- Backend model and tool brokers preserve connection ownership, computer placement, approval latches, and run leases. Fabric core overrides never fall back to host tools. Managed provider authority stays sealed across reloads.
- Fovea indexes bounded, authorized computer snapshots. Explicit roots retain isolated observation state; project configuration and plugins are not loaded from those snapshots.
- Runtime sessions retain Pi source entries, compaction boundaries, child transcripts, and stable participant identity separately from product messages. Clearing a thread fences old work and removes its queue, placement, and runtime state.

## Queue and inspection

One shared headless queue engine owns FIFO order, lanes, holds, edit sessions, dispatch reservations, and recovery. PostgreSQL commits reservations before delivery; uncertain delivery remains held for explicit reconciliation. The native Pi queue is not reconstructed from a second editable plan.

Web/Electron and mobile use the same queue and execution controllers. `manage_queue` exposes revision-checked natural-language control of the current private bot queue; external messaging runs, inbound webhooks, and children cannot read or mutate that private plan.

Queued work captures an immutable authorized computer/project binding. Missing or changed targets block rather than silently switching directories. Existing worktrees are selected with `cwd`; automatic `worktree: true` creation is explicitly rejected. Create a worktree through the authorized shell tool, then delegate to its explicit path.

A graceful pause parks the live turn at the next safe boundary and stamps the parked turn into the durable queue state under the run's lease. Resume of that parked turn records an explicit durable intent and wakes exactly one fenced continuation run with a fixed prompt; acknowledged queue rows are never replayed, and an empty queue resumes the parked turn itself. Session generation, ownership, or placement drift leaves the intent held with an actionable rejection instead of silently discarding it or restoring a stale checkpoint. Continuation restores the last saved runtime checkpoint only — there is no full replay guarantee for work the runtime had not committed at the pause boundary.

Flow is a projection of retained delegation, execution, messaging, continuation, and wait evidence—not a second workflow language. Historical events without source or outputs remain incomplete. Inspection and related-run discovery are scoped and bounded.

## Compaction, retry, and routing

After an eligible idle period, Fabric deterministically compacts before the next model request without a model summarization call. Source remains addressable through exact recall. An unchanged-source fingerprint prevents repeated compaction. This reduces cold-prefill volume; it does not promise a cache hit.

Retry activity and cancellation are retained. Final broker failures stop worker retries: an exhausted request must not be replayed by another retry owner. Same-provider credential pools use multiprovider; different models/providers require explicit fallback targets. Fallback never replays after output starts. Scheduler health is bounded process-local state; restarting a backend resets that health, not the saved routing policy. Credentials remain backend-only.

## Distribution and checks

Use Node 24 LTS (or a supported newer even-numbered release) and the repository's pinned pnpm version.

- `pnpm pi:kit:check`: validate installed identities and archive integrity/public exports.
- `pnpm sandbox:build`: build both the computer and isolated agent images for local development.
- Compose builds or selects the matching agent image automatically. Production updates include the supervisor. Existing deployments must recreate the updater when adopting this topology so its service list includes the supervisor.
- `pnpm pi:kit:vendor`: developer-only archive refresh after building and testing the sibling packages; update the lockfile and pinned identities together.

## Acceptance ledger

| Boundary | Evidence / remaining verification |
| --- | --- |
| Recursive cwd, inherited capabilities, and Fovea root continuity | Sibling conformance tests and fresh builds passed; packaged into the kit |
| Shared queue state and write-ahead acknowledgment | Offline tests and real PostgreSQL concurrency/recovery probes passed |
| Managed Fabric, all eight core overrides, Fovea snapshots, exact recall, and deterministic idle compaction | Installed-kit conformance probes passed |
| Same-provider rotation and explicit fallback | Scheduler tests and real offline SDK/HTTP probes passed |
| Shared queue/Flow/routing UI | App type checks, controller tests, browser control probes, and CI screenshot-test registration passed |
| Clean installation and migrations | Standalone kit resolution and clean PostgreSQL migration deployment passed |
| Atomic secret-preserving edits and delegation reservations | Raw-byte, concurrent-process, approval-boundary, reservation-race, and actual-executor PostgreSQL probes passed |
| Targeted participant queue controls and reviewed commands/gates | Real RPC child steering, retained images/source identity, compact acknowledgment, and non-deadlocking gate probes passed |
| Whole runtime acceptance | Full offline regression, all 23 workspace checks, all 20 isolated PostgreSQL suites, actual RPC/file persistence, and explicit paused-turn continuation probes passed |
| Production container enforcement and full-stack screenshots | Docker smoke and screenshot execution remain CI checks; local Docker daemon unavailable; Electron E2E intentionally not run |
