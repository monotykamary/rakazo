import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RunnerCredentials {
  serverUrl: string;
  machineId: string;
  machineToken: string;
  name?: string;
}

export const CREDENTIALS_FILE_NAME = "credentials.json";
const MACHINE_TOKEN_PATTERN = /^rk_m_[A-Za-z0-9_-]{40,}$/;
const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function runnerHomeFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RAKAZO_RUNNER_HOME?.trim()) return path.resolve(env.RAKAZO_RUNNER_HOME.trim());
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "rakazo-runner");
}

export function credentialsPath(home: string): string {
  return path.join(home, CREDENTIALS_FILE_NAME);
}

/** Server origin only: pairing and polling never accept a server-chosen path or query. */
export function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Server URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Server URL must use http: or https:");
  }
  if (url.username || url.password) throw new Error("Server URL must not contain credentials");
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Server URL must be the bare origin, without a path");
  }
  if (url.search || url.hash) throw new Error("Server URL must not contain a query or fragment");
  return url.origin;
}

export async function loadCredentials(home: string): Promise<RunnerCredentials> {
  let text: string;
  try {
    text = await readFile(credentialsPath(home), "utf8");
  } catch {
    throw new Error("This runner is not paired. Run 'rakazo-runner pair' first.");
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (typeof parsed.serverUrl !== "string") throw new Error("Credential file is missing serverUrl");
  if (typeof parsed.machineId !== "string" || !MACHINE_ID_PATTERN.test(parsed.machineId)) {
    throw new Error("Credential file has an invalid machineId");
  }
  if (typeof parsed.machineToken !== "string" || !MACHINE_TOKEN_PATTERN.test(parsed.machineToken)) {
    throw new Error("Credential file has an invalid machine token");
  }
  return {
    serverUrl: normalizeServerUrl(parsed.serverUrl),
    machineId: parsed.machineId,
    machineToken: parsed.machineToken,
    ...(typeof parsed.name === "string" && parsed.name ? { name: parsed.name } : {}),
  };
}

export async function saveCredentials(home: string, credentials: RunnerCredentials): Promise<void> {
  const serverUrl = normalizeServerUrl(credentials.serverUrl);
  if (!MACHINE_ID_PATTERN.test(credentials.machineId)) {
    throw new Error("Pairing returned an invalid machine id");
  }
  if (!MACHINE_TOKEN_PATTERN.test(credentials.machineToken)) {
    throw new Error("Pairing returned an invalid machine token");
  }
  await mkdir(home, { recursive: true });
  // A pre-existing wider directory (or hostile umask) must not expose the token.
  const directoryStat = await stat(home);
  if (!directoryStat.isDirectory()) throw new Error("Runner home is not a directory");
  if ((directoryStat.mode & 0o077) !== 0) await chmod(home, 0o700);
  const file = credentialsPath(home);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const payload = `${JSON.stringify({ ...credentials, serverUrl }, null, 2)}\n`;
    await writeFile(temp, payload, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function clearCredentials(home: string): Promise<void> {
  await unlink(credentialsPath(home)).catch(() => undefined);
}
