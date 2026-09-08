# Always-on bots

The server, not the app window, owns conversations, credentials, queues, checkpoints and execution. Keep one Rakazo API/worker, PostgreSQL and persistent data directory on an always-on machine. Web, Electron and mobile connect to the same HTTPS origin and account. Closing a client does not stop runs. A sleeping laptop cannot host this control plane, even when its bot computer is remote.

## Install the shared server

On a Linux server with Docker Engine, the Compose plugin, curl and OpenSSL, use a reviewed Rakazo checkout. Point a DNS name at it and allow inbound HTTP/HTTPS (80/443) for Caddy. Do not expose PostgreSQL, the supervisor or Docker's API.

```sh
bash infra/compose/deploy-server.sh \
  --host app.example.com \
  --allow-signup owner@example.com \
  --build --prepare-only
```

The command creates a private `rakazo-server/.env` with independent random secrets and restricts signup to the chosen email. Configure `SMTP_URL` and `EMAIL_FROM` for verification (self-hosted SMTP is supported), then repeat without `--prepare-only`. An email allowlist alone does not prove who owns an address. Existing installations can instead keep `SIGNUPS_ENABLED=false`.

Startup builds the checkout's matching app and computer images and starts the existing topology with a Caddy TLS overlay. No inference or sandbox vendor account is required. Connect a model using the normal connection settings after signing in.

Use `--directory` to choose the installation directory. `--prepare-only` prepares configuration without launching services. Without `--build`, select matching published image names/tags in `.env`; do not mix runner and server protocol versions. Existing secrets are kept. A different hostname or signup policy requires an explicit configuration edit, rather than silently changing a live server's identity.

After certificates are ready, verify `https://app.example.com/health`, then connect Electron using **Another server**, mobile using its server address setting, and the browser using that same URL. Use the same account to see the same bots. Server URLs must not contain credentials.

## Existing local installations

Changing server connects to a different database; it does not migrate bots or merge histories. The desktop app retains local data and origin-isolated login sessions. Switching back reconnects the old installation.

To move an existing installation, stop its worker and API before making a consistent PostgreSQL backup and copying its entire persistent application data with encryption keys. Restore those into the new server, update public origins, then connect clients. Do not run two writable copies of the same bot state. Follow [self-host backups](self-host.md#backup); do not copy browser cookies or overwrite a nonempty server as an implicit setup action.

## Connected machines

A connected machine supplies execution capacity for assigned bots; it is not another independent Rakazo database. Assign a bot from its computer settings without choosing a repository. Bots discover projects within their authorized workspace. A machine operator can inspect data delivered to that machine, so pair only machines you trust.

On the execution machine, use a reviewed checkout matching the server version:

```sh
bash infra/compose/install-machine.sh
```

This Linux-only installer builds matching runner, Pi and computer images, generates a private `.env.machine`, and starts an outbound-only Docker Compose stack. It publishes no host ports and installs `rakazo-runner` in `~/.local/bin`; add that directory to `PATH` if prompted. It requires Docker Engine, the Compose plugin and OpenSSL, not a host Node or Bun installation.

In a bot's settings, open **Runs on**, choose **Add machine**, and copy the pairing command. Run it on the execution machine, then select the paired machine for the bot. No repository selection is required. Pairing codes are short-lived and single-use; the runner stores its credential in a private persistent volume. The machine's supervisor secret stays on that machine. Revoking the machine stops new authorized work; it does not delete its files.

Run `rakazo-runner logs` to inspect connection failures, `rakazo-runner stop` to stop forwarding, and `rakazo-runner start` to reconnect. Stopping forwarding does not kill existing computer processes. To update, stop active bot work, review the matching checkout update, and rerun the installer; existing credentials, secrets and volumes are retained. Keep server and runner versions aligned.

Both the execution machine and the shared server must stay awake. macOS and Windows apps are clients; this installer does not install a native runner on those platforms.

The control plane must remain reachable. Network partitions hold uncertain work rather than automatically replaying commands or migrating active execution. Moving a bot requires a safe stopped boundary and a verified workspace checkpoint. Stop active bot work and its supervised services first. Each move uses a fresh placement and workspace generation, including a return to an earlier machine; old queued bindings cannot silently resume there. A failed move preserves the original assignment, though its computer may already have been stopped. Workspaces are portable; arbitrary live processes and OS packages are not. See [projects and services](services.md) for service approval, preview isolation and supported adapters. A repository's presence is not permission to run setup scripts, push code or deploy applications.

## Verify continuity

Start a bot from one client, close that client, open another client on the same server, inspect the same run and send a follow-up. Stop a runner during a command and verify that reconnection reports/reconciles uncertainty rather than running the command twice. Revoking a machine must reject its credential and prevent new work. Keep encrypted off-host backups of the database and application data; container restart policies are not backups.
