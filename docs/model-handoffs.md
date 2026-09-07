# Model handoffs

## Acceptance ledger

- [x] Bot pins are `Bot.modelProvider`, `modelId`, and independent `thinkingLevel`, not a named-bot or role-specific model table. Child bots copy pins at creation; durable dispatched workers capture an explicit model and effort. Existing controls live in `apps/web/src/pages/shell/bot-panel.tsx` and `apps/mobile/app/bot-settings.tsx`.
- [x] Reuse owner credentials, Space preferences and the generic model catalog. Missing pinned credentials and revoked owned secrets fail; they do not silently select another model or substitute deployment credentials. An exact deployment-default pin may use its already configured deployment auth without a user credential row.
- [x] Worker preferences have one durable source, separate from fenced session checkpoints. Clearing an override restores current bot inheritance, not stale checkpoint intent.
- [x] Managed RPC performs idle compaction, model/effort setters, live confirmation and durable commit before normal inference. No-op checks live SDK state, including equivalent default effort.
- [x] Busy requests do not mutate an active tool or erase history. Requested and effective selections remain distinct. Failed compaction/checkpointing preserves the old committed configuration and can be retried.
- [x] Real managed subprocess tests cover order, reasoning-only changes, busy tools, failure/retry, checkpoint rollback, parent shutdown, stable child identity and reset/inheritance. Real SDK tests cover deterministic summaries and genuine cancellation through an abort hook, not a mocked compact result.
- [x] Model routes check thread/bot/participant ownership and expose only public configuration. New hidden bot/worker/routing targets are rejected; unrelated title/instructions edits preserve unchanged hidden bot pins. Existing hidden requested pins remain visible as failed without changing effective metadata. Runtime owner checks cover the final resolved identity and each actual broker target; configured hidden fallbacks are excluded before credential resolution.
- [x] Verified final target-window staging, file-only real Fabric facade delegation denial, saved-child admission, and deployment-backed pin compatibility after the frozen install. The final targeted offline set passed 130 tests across 17 files; adapters and API TypeScript checks passed. CI remains deferred.

## API

`models.getSelection({botId, threadId, participantId?})` returns:

- `requested`: current explicit preference, or resolved current bot configuration when inheriting;
- `effective`: the last verified, durably committed session configuration, or `null` before one exists;
- `status`: `pending`, `applied`, or `failed`, with a sanitized nullable `error`.

`models.setWorkerSelection({botId, threadId, participantId?, selection})` accepts `{provider, modelId, thinkingLevel}` or `null`. With a participant, `null` deletes only that scoped override and restores bot inheritance. Without a participant it updates the addressed bot's pins, including hidden durable worker bots; `null` uses the Space default, matching bot settings. Root bot settings continue to use `bots.update`.

Saving an intent does not start inference, interrupt a tool or claim immediate application. Retrying the same failed intent leaves failure visible until the participant is resumed successfully. Nullable thinking means model default; effective thinking records the actual resolved level.

## Corrected inherited behavior

- Removed checkpoint-request fallback and the third resolver callback argument that resurrected cleared worker pins.
- Removed generic `Compaction cancelled` suppression, including advisory compaction. It is not proof of success. Added a post-compaction target-window check: the SDK can also mislabel a huge unsplittable first turn as “session too small,” which must not acknowledge an oversized handoff.
- Replaced metadata-only no-op acknowledgement with live model/effort confirmation.
- Removed silent default-model and deployment-key substitutions for revoked pins/secrets.
- Moved the existing thinking enum to the foundational model-selection contract to break the `domain → events → work → model-selection` import cycle; compatibility exports remain.

## Runtime boundaries and limitations

Managed Fabric exposes backend-scoped `agents.run`, not native actor/setModel APIs. Child admission also requires `run_subagent` in the current participant tool scope; file-only workers cannot regain delegation via facade calls or saved-child resume. Worker choices use Rakazo's existing credentials and catalog. No sibling extension source or kit archives were changed for model handoffs.

A busy participant finishes its current activation on its effective configuration. New model/effort intent is applied at its next fenced activation, not between tool calls. A newly hidden model is independently denied before its next inference, including retries/fallbacks; an already running tool or inference is not rewritten midway.

The deterministic compactor uses SDK model metadata for its context budget. The compact RPC may temporarily stage the authorized target metadata while idle, restoring the old model/effort in `finally`; normal prompts remain blocked until the successful handoff commit. Full session entries remain stored. Legacy sessions without verified model metadata report effective `null` until confirmation.

The pinned SDK uses the same cancellation error for genuine aborts and some no-reduction/budget outcomes. These all remain visible, retryable failures; there is no paid-summary fallback. The SDK's explicit empty/small-window result, or a previously verified unchanged window, is a compaction no-op only when the live context fits the target response reserve. The bundled Fabric compactor can use compact-all when no retained suffix fits, preserving the full source log. An unsplittable SDK preparation or over-budget summary may still require choosing another model or returning to the old configuration; retrying identical impossible input cannot make it fit. Context estimates remain heuristics, not a guarantee of provider-exact tokenization.

Tests are deterministic and offline, including real managed Pi RPC and SDK execution against synthetic local model emulators. No desktop Electron E2E, hosted model calls, CI, commits, pushes or PR operations were run.
