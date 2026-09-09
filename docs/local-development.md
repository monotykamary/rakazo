# Local development

Rakazo has two execution modes. Trusted-local development uses your Pi executable,
configuration, credentials, extensions, skills and configured default model. Managed
execution keeps the pinned, isolated workers described in [pi-execution-kit.md](pi-execution-kit.md).
The managed mode never silently falls back to your host.

## Start from source

Use the repository-pinned Bun version, supported Node, and Apple `container` with
Mocker on macOS. Bun manages the workspace; Node runs the backend and Pi.

```sh
bun install --frozen-lockfile
bun run dev
```

On first use, approve the trusted-local prompt. For an intentional noninteractive
start, use `bun run dev --trust-local-pi`. This permits host commands and access to
your Pi credentials; it is not a container sandbox. The backend is loopback-only,
and only the deployment owner may use local execution. Other users and incompatible
remote placements do not inherit that authority.

The bootstrap generates missing private configuration, provisions persistent
PostgreSQL with Mocker/Apple containers when it owns the dev database, applies
migrations, starts a stable execution worker, and watches the API and web. Open
<https://rakazo.localhost>. Electron is never launched automatically. Portless assigns
the internal Vite port and sends browser API and RPC requests through that same origin;
the generated public URL is used for authentication only at runtime and is not written
to `.env`. Linked worktrees receive their own prefixed hostname. Sign in again at the
named URL; browser cookies from the old address do not transfer between origins.

Portless uses HTTPS by default. On first use it may ask permission to bind the privileged
HTTPS port, create and trust a local CA, and synchronize host entries. Review the prompt
before approving it; Rakazo does not run those setup commands separately. To avoid
Portless in CI or another noninteractive flow, set `PORTLESS=0`; managed startup remains
unchanged.

To intentionally use the `.test` TLD, start the proxy first, then run dev:

```sh
bun x portless proxy start --tld test
bun run dev
```

The named URL is then `https://rakazo.test` (with a worktree prefix when applicable).
The proxy command can require elevated CA/port permissions and can update `/etc/hosts`;
do not run it unless those changes are intended. Portless reuses that explicit proxy
configuration on later starts.

Existing configuration and database URLs are preserved. An existing database URL is
an external dependency, not permission to replace its container or erase its data.
Keep the encryption key stable across restarts. Never commit `.env` or `data/`.
Ctrl+C stops the API/web launcher, not the stable worker or database storage. Fresh
setups choose an available loopback database port. Owned PostgreSQL uses a native
Apple volume with a private ownership record; unknown volumes and missing previously
owned storage are rejected rather than adopted or silently replaced.

## Build Rakazo while it is working

When upgrading from the old watched worker, let its active jobs finish before
stopping the old dev command. Trusted-local `bun run dev` then keeps the entire
execution worker outside the API/web watcher process group and Portless’s descendant
process tree. The worker must be adopted by the system init process before it starts
jobs; environments with a different subreaper fail closed. Restarting dev retains active Pi RPC processes, Fabric work,
tool callbacks and job leases. It does not merely detach a Pi child whose bridge dies.

```sh
bun run dev:worker:status
bun run dev:worker:stop
bun run dev:worker:restart
```

Stop requests a drain and returns; poll status until stopped before maintenance.
Restart drains before loading new worker code. Dev refuses pending database
migrations while a worker exists; stop it, wait for stopped, then run dev to migrate. API/web restarts keep the old worker code until this explicit restart.
Changed runtime configuration is rejected rather than silently reused. Private
ownership state under `DATA_DIR/.dev-worker` authenticates reuse; a recorded PID is
never authority to kill a process. An orphaned state directory requires inspection,
not deletion while its worker may still be alive. Keep DATA_DIR non-symlinked and
private. Startup/output diagnostics are retained in the private
`DATA_DIR/.dev-worker/worker.log` until the owned worker stops. This lifecycle
currently requires POSIX; managed development remains the
explicit alternative on unsupported hosts.

Office actions on web/Electron and mobile send ordinary chat prompts. The bot uses
its discovered tools and bundled Rakazo skill to plan the work; bot templates are
generated with existing tools, not a new template-management subsystem. Pi retains
its normal system prompt and Fabric guidance. Rakazo app context is read on demand
with `get_bot_context`, rather than repeating a tool manual every turn.

`manage_office` inspects paired offices and queues explicitly approved managed moves.
The backend waits for the originating run and active work, verifies the workspace
copy and atomically switches placement. Pending moves survive worker restarts;
interrupted in-flight transfers fail closed and may retain the source latch for
operator inspection. Do not clear that latch until the old worker/copy is proven
stopped. Pairing and revocation remain available under **Manage offices**, with
pairing credentials outside the conversation.

A paired machine is not an independent deployment: the original API/database may
still require the laptop. Native Pi profiles, credentials and repositories are not
automatically exported. The bot can plan and prepare an independent VPS using
available Pi/Fabric tools and the existing deployment script, with explicit consent
for infrastructure and data transfer. Complete control-plane migration is not an
atomic app operation; verify destination health, model access, repositories and
conversation continuity before cutover.

## Your Pi installation

An existing `pi` on your shell PATH is preferred. Dev removes Bun’s injected
workspace-bin prefix before launching Pi or the persistent worker; workspace build
commands still use their local tools. This also applies to `dev:pi` and worker
restart. `RAKAZO_PI_COMMAND` selects another executable;
it is a path/name, not a shell command. `RAKAZO_PI_CWD` selects an absolute project
directory. Pi retains its normal user configuration and saved project-trust rules;
Rakazo does not implicitly approve project extensions or change the global model.

Rakazo creates its own bot/conversation sessions under the configured data directory.
It does not attach to a running terminal session or take over an existing session
file. Your terminal Pi remains independent. Credentials stay in Pi rather than being
copied into Rakazo's connections database.

If Pi is missing, the bootstrap offers a pinned local installation. Installing the
reviewed extension kit is an explicit choice, not an automatic overwrite of an
existing Pi setup. Installing packages does not authenticate a model provider: use
Pi's `/login` and `/model` when configuring a fresh installation:

```sh
bun run dev:pi
```

`bun run dev:kit` explicitly installs an isolated reviewed kit. For Fabric full-code
capture, use Fabric 0.90.1 or newer; the bundled kit includes this fix.

## Local-mode boundaries

The configured Pi cwd is the placement root. Backend-authorized project, worktree and
Team subdirectories beneath it use the same canonical directory for Pi and product
tools. Outside paths and symlink escapes are rejected. Between-run directory changes
preserve native history in a new owned session generation, with retry recovery if
checkpoint saving fails. Mid-run cwd changes require a new run; pending queue intent
retains its original workspace rather than silently moving with the bot.

Interactive extension dialogs are cancelled with an error; handle configuration in
`bun run dev:pi`. Ambiguous stale session locks fail closed rather than taking over
another Pi process.

Stock RPC streams replies, tools, usage, retries and compaction. Fabric custom records
are projected at completion, not as the managed runtime's live TTL/subagent stream.
External webhooks, messaging ingress, remote/bot-triggered runs and non-owner access
are disabled in local mode; they do not inherit host authority.
Native workspace lifecycle operations never delete or automatically export the project.

## Native and managed computers

Trusted-local mode uses the existing native file/shell computer adapter. It does not
provide a virtual graphical desktop. Apple containers run PostgreSQL; a Docker
daemon, sandbox supervisor and isolated agent-image build are not prerequisites for
this mode. Pi and its extensions can use the host's installed development tools.

The web and Electron renderer use the same backend. Physical mobile devices cannot
connect directly to this loopback-only stack; use a managed deployment for that surface.
With the source stack running:

```sh
bun run --filter @rakazo/desktop dev
```

Choose **Another server** and enter `https://rakazo.localhost` (or the exact URL printed
by dev for a worktree or custom TLD). The packaged desktop
**This computer** installer is a different deployment path, not this source watcher.

Managed deployments retain their existing configuration and prerequisites. Use
`bun run dev:managed` for the original API/worker/web/supervisor watcher set after
configuring its database, supervisor credentials and matching sandbox images.
This does not migrate managed workloads or remote machines into trusted-local Pi.
