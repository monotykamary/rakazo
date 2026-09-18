# Handpicked upstream adaptation: 6d7da581

This rollout adapts behavior from upstream without merging or replaying commits.
The fork's managed Pi/Fabric runtime, office handoff and egress, remote providers,
Bun tooling, identity, and existing navigation remain authoritative.

## First batch: incorporated and checked

Status reflects local verification, not upstream CI. This is the first adaptation
batch, not a claim that every recommendation below has shipped.

- [x] Tool schemas (#830, #853, #854): credential destinations, exclusive credential/connection inputs, unions, constants, nullability, closed objects, and OpenAI-compatible object envelopes. Malformed schemas fail closed. Native RPC and local dispatch retain raw arguments.
- [x] Connector safety (#839, `b42212b3`): revoked connections are excluded; stored and refreshed OAuth material is redacted from results, call errors, failed reconnects, and discovery errors.
- [x] MCP compatibility (#808, #876, #885, #897, #901): package-matched Undici fetch/Agent, pinned address checks, Tailscale IPv6, bounded origin fallback with caller cancellation, and `connectors_*` catalogs with legacy approval replay.
- [x] Execution safety (#864, relevant #884 behavior, #877): effects include run/tool/call/request identity; benign dot arguments are accepted while protected shell commands remain blocked. The fork's durable occurrence cursor is retained rather than copying upstream's fresh-agent counter reset into a persisted managed session.
- [x] Database capacity (#865): API/worker query and job pools are shared, capacity retries are bounded, worker restarts back off, shutdown clears retry timers, and run setup requeues with checkpoints and lease fencing intact. Unrelated failures still propagate.
- [x] Computer lifecycle (#813, #818, #850, #880, #896): named-volume subpaths, browser-profile argv validation, optional serialized per-Space admission, abandoned suspend recovery, and prompt signal shutdown. Existing machine/provider and Office fencing remain authoritative.
- [x] Source Compose safety (#821): configured database password, no default host-published Postgres port, and an explicit loopback-only development overlay. Existing-volume credential and Docker API requirements are documented in `docs/self-host.md`; Bun/mocker startup remains unchanged.
- [x] Native reliability (#812, #888, #891): Space-generation fencing, full-capability-URL screen caching with renewal/invalidation, computer lifecycle deadlines, and caller/timeout abort reasons. No token-stripping identity shortcut was imported.
- [x] Runtime context (part of #884): current-time instructions in root/helper requests and cached-token accounting in native/local model bridges, without another agent runtime.
- [x] Plain-text previews (#914 proposal): one shared helper for thread listings, native snippets, and completion pushes. Markdown is removed before truncation; stored transcript content and cleared-session boundaries are preserved.

### Verification and integration corrections

- Offline verification covers 4,993 passing tests across the full sweep and targeted rechecks; 212 database/provider-dependent tests remain skipped. The full sweep exposed 31 failures in nine files. Session-boundary fixtures, updated Pi handshake/action/model expectations, and the desktop shutdown assertion were corrected without dropping their safety checks; missing existing Chinese labels and an omitted PostgreSQL suite registration were added. All 110 tests in those nine files then passed. Earlier queue-control and computer-lookup fixture corrections also passed their targeted checks.
- Type checks passed for core, database, adapters, API, worker, runner, web, supervisor, updater, and mobile. Expo dependency validation was offline.
- The new headless Chromium preview scenario passed against isolated Postgres and the scripted runtime, preserving stored Markdown and capturing the sidebar screen. Electron E2E and native device builds were not run.
- Browser verification exposed an existing Node crypto import in the shared core barrel. Replica hashing now uses `@rakazo/core/node/office-replica`, with both server consumers updated and journal regressions passing. Two existing root-only Fabric command union-narrowing errors were also corrected without changing dispatch semantics.
- Changed-source formatting/lint and whitespace checks passed. Structural/source review covered the security and recovery paths; graph coverage is partial and is not a correctness guarantee. No dependency upgrade, upstream merge, cherry-pick, or release change is included.

## Next feature batches

Not implemented merely by listing them here: screen capability lifecycle revocation
and proxy recovery; touch keyboard/trackpad/paste and landscape; quotes; chat during
takeover and free-text answers; section renaming; voice disconnection; model
capability controls; mobile consent; Serenity; avatar editing; native account/version
polish; and remaining runtime output/stream limits. These need end-to-end
fork-specific integration and verification.

UIScene (#889) is explicitly deferred: the installed Expo `57.0.21` and
expo-modules-core `57.0.17` lack the scene delegate/factory APIs used by upstream's
plugin. Adopt it with a compatible dependency update and native build validation,
not an unregistered or nonfunctional plugin. The branch-only supervisor symlink
containment work also remains a separate security-review priority.

Optional proposals remain separate: task catalog, private MCP endpoint policy,
CreateOS, Daytona snapshots, per-user quota, CGNAT deployment support, autonomy,
voice favorites, and heuristic mail redaction. Do not copy branch-only policy,
deployment identifiers, provider-specific environment switches, release numbers,
or wholesale branding/catalog/runtime changes.

# Previous adaptation: c288959

Reviewed the 43 upstream commits after the shared base, through `c288959`.
This is a selective adaptation, not a merge of upstream product or runtime design.

## Incorporated

- `a4370de`, `616d235`: real desktop setup progress, long-pull liveness, and authenticated server readiness rather than accepting an unrelated HTTP response. Progress logs are bounded.
- `d4a5477`: desktop model authorization opens in the default browser, preserving web behavior.
- `276048c`: translated picker search and create labels, with regression coverage in a non-English locale. Existing locales remain intact.
- `8405a99`: replies carry bounded parent context; emoji reactions are durable, idempotent user messages without starting a run. Web and mobile render and send them. Unlike the upstream migration, historical thumbs-ups and the old RPC input remain supported.
- `95710ae` (partial): native keyboard/layout and empty-thread fixes, accessible avatar actions, and persisted bot profile events. Web also refreshes profiles from those events. The fork's identity colors and activity, memory, work and queue surfaces remain.
- `6ad1b15`, `ab267bf`: stable model conversation identity and connected-model affinity, adapted to the fork's Pi RPC and native Fabric workers rather than introducing another agent implementation.
- `c14238c`: preserve executor-owned shell cwd defaults in both root and native-worker dispatch. Explicit placement continues to be authoritative.
- `de591ae`, `c288959`: discoverable empty-space deletion, backend deletion claims and creation locks, bounded teardown, ownership checks, native selection recovery, and safe fallback after deletion. Existing remote-machine/control leases are reconciled before cascading deletion.
- `496f649` (partial): updater retry correctness without replacing the fork's update UI.
- `b423545` (partial): lifecycle ownership/CAS fixes without introducing a parallel background update workflow.
- `027a20d` (partial): OAuth refresh/client-metadata correctness, retaining provider-neutral connection management rather than importing a new integration setup workflow.
- `2ae0037`: disable unconfigured Stylelint review; Biome remains authoritative.

First-use adaptation also records `User.onboardedAt` transactionally on bot creation,
backfills existing usage, bots and deletion records, and exposes `Me.hasOnboarded`.
Deleting every bot no longer means first use. Empty optional-space onboarding has a
Back action, while the current first-bot form and its fields remain unchanged.

## Retained or deferred

- `2dae0ae`, `c5dfd54`, `885142f`, `264c2b5`, `6673b7b`: retain the fork's corresponding picker, dialog, spend-attribution and loopback-auth fixes rather than replaying overlapping patches.
- `b30b93e`: retain the Pi RPC/Fabric-native auditing, continuation and completion lifecycle; do not add parallel pi-agent-core orchestration.
- `89991ec`: defer broad dependency pinning and the TypeScript 7 migration. Keep the Bun lockfile and current supported toolchain.
- `1516955`: retain this repository's contribution/review instructions rather than importing a conflicting review skill.
- `8bb0f4e`, `37b54b2`, `1102ad8`, `84c8689`: upstream desktop release numbers are not fork releases.
- `0aa6626`, `9db117d`: store-review media and upstream identity assets are not fork product fixes.
- `a0598e9`, `d0e9376`, `78fe74f`, `4153ec3`: retain the fork's remote-aware, progressively disclosed copy rather than adding upstream explanations.
- `3ab44d5`, `34110ba`, `1a1f7b8`, `c222bab`: defer replacement settings, voice, desktop-menu and onboarding flows; preserve current fork navigation and capabilities.
- `0bf0fda`, `8a0e688`: retain the fork's semantic monochrome styling and existing progressive timestamp presentation.
- `da8895f`, `65c6474`, `e39f2d8`: do not import provider-specific defaults, a new voice provider, or a separate advanced-model configuration surface as bug fixes.
- `489a9da`: defer a new locale until fork-specific strings are covered; do not overwrite existing translated catalogs wholesale.

## Verification scope

Regression coverage includes sandbox destroy retries, fenced deletion and authorization,
permanent last-bot deletion, optional onboarding escape, native selection persistence,
reply bounds and isolation, legacy/new reactions, native keyboard/avatar behavior,
localized pickers, OAuth, and Pi worker placement/model identity.
Desktop verification uses unit tests only; Electron E2E is reserved for CI.

Verification completed:

- The full offline sweep passed 4,330 tests and identified 13 failures. Six stale
  fixture failures were corrected; seven heavyweight process cases received explicit
  startup budgets. All 13 then passed targeted rechecks, without removing assertions
  or changing production timeouts. Ordinary RPC test budgets remain unchanged.
- All workspace TypeScript checks passed, using offline Expo validation to avoid
  registry-version drift. The production web/catalog build passed.
- Fifteen PostgreSQL authorization/lifecycle tests and eight headless Chromium
  scenarios passed. The latter include emoji persistence, paginated replies, touch
  actions, localized pickers, permanent deletion and optional onboarding escape.
- A rollback-only SQL probe verified each historical first-use backfill branch and
  confirmed that genuinely unused accounts remain unmarked.
