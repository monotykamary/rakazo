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
migrations, and starts the API, worker and web watchers. Open
<http://127.0.0.1:5173>. Electron is never launched automatically.

Existing configuration and database URLs are preserved. An existing database URL is
an external dependency, not permission to replace its container or erase its data.
Keep the encryption key stable across restarts. Never commit `.env` or `data/`.
Ctrl+C stops the development processes without deleting database storage. Fresh
setups choose an available loopback database port. Owned PostgreSQL uses a native
Apple volume with a private ownership record; unknown volumes and missing previously
owned storage are rejected rather than adopted or silently replaced.

## Your Pi installation

An existing `pi` on PATH is preferred. `RAKAZO_PI_COMMAND` selects another executable;
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

Choose **Another server** and enter `http://127.0.0.1:5173`. The packaged desktop
**This computer** installer is a different deployment path, not this source watcher.

Managed deployments retain their existing configuration and prerequisites. Use
`bun run dev:managed` for the original API/worker/web/supervisor watcher set after
configuring its database, supervisor credentials and matching sandbox images.
This does not migrate managed workloads or remote machines into trusted-local Pi.
