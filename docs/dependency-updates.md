# Dependency updates

Use `bun outdated --recursive` to inspect every workspace. Updates preserve local
vendored Pi kit archives and workspace dependencies; they do not change the user's
global Pi installation.

The current update uses the latest registry releases except for these verified
compatibility boundaries:

- **Prisma CLI 7.10.x:** Prisma 8 RC is the new unified CLI, not a drop-in update to
  the classic ORM command surface. Its `prisma generate` command fails as unknown.
  Keep the classic CLI with the 7.10 client/adapter until the schema, generation and
  migration workflow is deliberately migrated. RC status alone is not the reason.
- **Expo SDK 57 native dependencies:** follow the SDK's bundled native-module map,
  including React Native 0.86.3 and its React 19.2.3 renderer. Shared React overrides
  keep web/mobile consumers consistent. Do not independently bump React or native
  modules past that supported combination; `expo install --check` remains enabled.
  Mobile also retains Babel 7 for Expo/Worklets; web uses Babel 8. The Worklets
  patch resolves its undeclared generator/traversal imports through its declared Babel peer
  so isolated installs do not depend on accidental hoisting.
- **TypeScript 6.0.x in mobile and the website:** mobile follows Expo's supported
  toolchain. Astro's checker needs the programmatic TypeScript API that TypeScript
  7's native compiler does not provide. Other workspaces use TypeScript 7.

The Babel 8 toolchain requires Node 24.11+ on the supported LTS line (or Node 26+).
The Better Auth update adds an `invitation.createdAt` migration, with a database
default that backfills existing invitations. Drain the dev worker before applying
pending migrations; startup never migrates underneath active work.

Compatibility adaptations include explicit Node types for TypeScript 7, JSONC
parsing without its removed compiler API, Lingui 6's PO formatter, Vite 8's separate
Babel transform, and Vitest 5's explicit serial-suite options/native module mocking.

The offline suite caps worker concurrency at two because real Pi integration tests
spawn additional SDK processes. Keep test isolation, assertions, and timeouts intact.

Verification commands:

```sh
bun install --frozen-lockfile
bun run test:install
bun run check
bun run test
bun run --filter @rakazo/web build
bun run --filter @rakazo/web intl:compile
bun run --filter @rakazo/desktop build
bun run --filter @rakazo/www build
```

Desktop build is headless. Do not run desktop Playwright as routine local verification.
