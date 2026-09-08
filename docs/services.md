# Projects and services

Bots discover projects inside their authorized computer workspace; attaching a machine does not require a repository picker. `discover_projects` inspects Git metadata without executing repository code, following arbitrary symlinks, or inspecting unrelated host directories. A bounded result reports truncation; narrow `directory` to continue. A natural-language reference must resolve unambiguously before work receives an explicit `cwd` or `project_path`. Discovery does not grant permission to install dependencies or start services.

## Long-running services

Ask a bot to start a development service, then approve its `computer_services` request. The backend supervises an exact argument array, workspace-relative directory, declared ports and optional environment. Service mutations require explicit approval; listing services and reviewing changes are read-only. Authentication and current computer placement are rechecked server-side. Team bots may declare services only in their own area or `shared/`.

The bot's Services panel shows its declared services, start/stop/restart controls and available previews. `keepAlive` prevents idle suspension while a service is active; it is not an unlimited cloud uptime guarantee. Removing a declaration removes its supervisor configuration, not project files. Service failures are visible without pretending that the bot's task completed successfully.

Docker computers and paired Docker machines support this capability. Other adapters report it unavailable until they implement the shared capability; no hosted provider is required. Git change evidence disables external diff, text conversion and filesystem-monitor hooks.

## Previews

Previews use short-lived, membership-, owner-, computer- and service-generation-bound bearer URLs. They expose only a declared loopback port, not an arbitrary host or internal desktop/control endpoint. Restarting, stopping, moving, deleting or redeclaring a service invalidates old links. Membership loss also revokes access.

HTML previews have an opaque sandbox origin. Modules, relative assets, JSON requests and local redirects stay within the capability path. No application cookies, authorization headers or backend credentials are forwarded. Token-only preview CORS is deliberately separate from credentialed API CORS. Response bodies and redirects are bounded; internal control ports are reserved at every execution boundary.

This is a development preview, not public hosting. Absolute URL rewriting is best-effort; WebSockets, service workers, arbitrary external redirects and cookie-dependent applications are not supported. A preview cannot read the surrounding Rakazo application.

## Verification

The deterministic offline suite covers service contracts, authorization, control-port exclusions, lifecycle generations and supervisor translation. Run the real headless Chromium isolation probe with:

```sh
VERIFY_BROWSER=1 bunx vitest run packages/testkit/src/service-preview.browser.test.ts
```

The probe serves real HTTP responses and checks module imports, styles and images, JSON POST preflight, opaque-origin isolation, redirects, bodyless responses and revoked generations. It needs Playwright Chromium installed, but no database, Docker daemon or Electron window.
