# Workspace installation

Use **Bun 1.4.2** for package management and **Node 24.x or 26+** for Pi and tools.
The root `packageManager`, `engines`, and preinstall check pin this contract.
Do not use `--bun`: Bun's runtime is not the upstream Pi runtime.

```sh
bun install --frozen-lockfile
bun run db:generate
bun run test:install
bun run pi:kit:check
bun run test
```

`bun run test` runs Vitest with the existing offline environment setup. `bun test`
is Bun's own runner and is not the Rakazo test command. Database generation and
Docker/provider suites remain explicit; installing dependencies does not start services.

## Workspace commands

- Scripts: `bun run --filter @rakazo/web build`.
- Workspace-local binaries: `bun run --cwd packages/db prisma migrate deploy`.
- Root-local binaries: `bun run vitest run packages/core/src/self-update.test.ts`.
- Forward arguments after the script: `bun run test:evals --list`.

A filtered `run` selects scripts, not arbitrary executables. Do not translate a
filtered `exec` into `bun --filter ... exec`, and do not use `bunx` for installed
build/test tools: it may download a missing binary rather than fail locally.

## Reproducibility and native packages

`bun.lock` is the only active lockfile. The root `workspaces` list replaces the old
workspace YAML; `overrides` preserves the shared React version and
`patchedDependencies` preserves the reviewed app-builder-lib signing fix. Keep
`patches/` and `vendor/pi-kit/` in the Docker context. Never refresh the vendored
archives as part of an install; their manifest SHA-256 hashes and public exports
are tested by `bun run pi:kit:check`.

`bunfig.toml` uses the isolated linker. Expo's existing Metro resolver keeps React
and React Native rooted in the mobile app; Electron does not gain mobile native
dependencies. Optional platform packages remain enabled. The updater and supervisor
images install only their production workspace dependency closure, but copy the
complete manifest graph so a frozen install can validate the same lockfile.

The explicit `trustedDependencies` list replaces Bun's default trust list:

- `@ast-grep/cli`, `esbuild`, and `koffi`: platform binaries.
- `@prisma/engines` and `prisma`: engine setup and upstream Node checks.
- `electron` and `electron-winstaller`: desktop binary/platform setup when present.
- `ssh2` and optional `cpu-features`: optional native acceleration; upstream supports fallback.

Informational hooks in `core-js`, `protobufjs`, and the no-op `@google/genai`
preinstall are not trusted. Vendored Pi packages ship built artifacts and are not
trusted to run install scripts. Review new lifecycle requirements rather than
using `bun pm trust --all`.

`bun run test:install` verifies workspace links, the installed signing patch,
Node-only queue headless/protocol imports, native isolation, command forwarding,
and an offline temporary-workspace frozen-install regression. No Electron windows,
provider calls, or shared dependency mutations occur in those tests.

## Switching an existing checkout

Coordinate a pause with anyone using the shared working tree before replacing an
old dependency installation. Do not remove `node_modules` while another process
is building or testing. Run the frozen install and the probes above before retiring
the old package-manager cache.

Cache cleanup is a separate, agreed maintenance step: use supported `pnpm store
prune` only after confirming the store is not in use by sibling projects. Do not
recursively delete a home directory or a shared store. Record before/after usage
when measurable. Skipping cleanup does not affect Bun's frozen-install contract.

Remaining `pnpm` strings are limited to these migration/cleanup instructions,
negative regression assertions, generic user-command parser fixtures, and immutable
third-party archive content. They are not active development or deployment commands.
