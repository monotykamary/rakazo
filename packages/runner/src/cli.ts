import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCredentials,
  normalizeServerUrl,
  runnerHomeFromEnv,
  saveCredentials,
} from "./credentials.js";
import { runForwarder, supervisorFromEnv } from "./forwarder.js";
import { MachineRevokedError, RUNNER_VERSION, TunnelClient } from "./tunnel-client.js";

const USAGE = `rakazo-runner — outbound machine runner for a paired Rakazo server

Usage:
  rakazo-runner pair --server <origin> --code <pairing-code> [--name <name>]
  rakazo-runner run

The runner is outbound-only: it never listens on a port, points at its own
local supervisor with its own local secret, and never forwards that secret to
the server or a model.

Environment:
  RAKAZO_RUNNER_HOME        runner home for credentials and the crash journal
                            (default ~/.local/state/rakazo-runner)
  RAKAZO_SERVER_URL         server origin for pairing when --server is omitted
  RAKAZO_SUPERVISOR_URL     local supervisor base URL (default http://127.0.0.1:7091)
  RAKAZO_DATA_DIR           shared persistent data root (also the supervisor's DATA_DIR)
  RAKAZO_SUPERVISOR_TOKEN   local supervisor bearer token (or SANDBOX_SUPERVISOR_TOKEN)
`;

/** Registers a stop listener; the returned function removes it again. */
export type SignalRegistrar = (listener: () => void) => () => void;

/** SIGTERM/SIGINT stop the runner gracefully: pending HTTP cancels, the journal flushes. */
export function processSignalRegistrar(): SignalRegistrar {
  const names = ["SIGTERM", "SIGINT"] as const;
  return (listener) => {
    for (const name of names) process.on(name, listener);
    return () => {
      for (const name of names) process.off(name, listener);
    };
  };
}

/** Strict `--flag value` parsing: unknown options, duplicates, and flag-like values fail. */
function parseFlags(argv: string[], allowed: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !name?.startsWith("--") ||
      name.length < 3 ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(`Expected --flag value near ${name ?? "(end of arguments)"}`);
    }
    const key = name.slice(2);
    if (!allowed.includes(key)) throw new Error(`Unknown option ${name}`);
    if (key in flags) throw new Error(`Duplicate option ${name}`);
    flags[key] = value;
  }
  return flags;
}

function flagsOrExit(argv: string[], allowed: readonly string[]) {
  try {
    return { flags: parseFlags(argv, allowed) };
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return {};
  }
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  registerSignals?: SignalRegistrar,
): Promise<number> {
  const [command, ...rest] = argv;
  const home = runnerHomeFromEnv(env);
  if (command === "pair") {
    const parsed = flagsOrExit(rest, ["server", "code", "name"]);
    if (!parsed.flags) return 2;
    const flags = parsed.flags;
    const server = flags.server ?? env.RAKAZO_SERVER_URL;
    const code = flags.code ?? env.RAKAZO_PAIRING_CODE;
    if (!server || !code) {
      console.error(
        "pair requires --server and --code (or RAKAZO_SERVER_URL and RAKAZO_PAIRING_CODE)",
      );
      return 2;
    }
    // The server origin is persisted with the credentials so `run` never needs
    // pairing-time environment and never accepts a server-chosen path later.
    const serverUrl = normalizeServerUrl(server);
    const paired = await TunnelClient.pair(serverUrl, {
      code,
      ...(flags.name ? { name: flags.name } : {}),
      version: RUNNER_VERSION,
    });
    await mkdir(home, { recursive: true });
    await saveCredentials(home, {
      serverUrl,
      machineId: paired.machineId,
      machineToken: paired.token,
      ...(flags.name ? { name: flags.name } : {}),
    });
    console.log(
      `paired as machine ${paired.machineId}; credentials stored in ${path.join(home, "credentials.json")}`,
    );
    return 0;
  }
  if (command === "run") {
    const parsed = flagsOrExit(rest, []);
    if (!parsed.flags) return 2;
    const credentials = await loadCredentials(home);
    const supervisor = supervisorFromEnv(env);
    const stop = new AbortController();
    const detach = registerSignals?.(() => stop.abort());
    try {
      await runForwarder({
        credentials,
        home,
        supervisor,
        signal: stop.signal,
        log: (message) => console.log(message),
      });
    } catch (error) {
      if (error instanceof MachineRevokedError) {
        console.error("machine access revoked; stopping");
        return 3;
      }
      throw error;
    } finally {
      detach?.();
    }
    return 0;
  }
  console.error(USAGE);
  return command === "--help" || command === "-h" || command === "help" ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2), process.env, processSignalRegistrar()).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
