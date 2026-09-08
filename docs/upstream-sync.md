# Upstream adaptation: c288959

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
