import path from "node:path";

export class PortlessConfigurationError extends Error {}

export const PORTLESS_NAME = "rakazo";
export const PORTLESS_CHILD = "RAKAZO_DEV_PORTLESS_CHILD";
const PORTLESS_BASE_ENV = "RAKAZO_DEV_PORTLESS_BASE_ENV";
const portlessInjectedKeys = [
  "PORT",
  "HOST",
  "PORTLESS_URL",
  "PORTLESS_TAILSCALE_URL",
  "PORTLESS_NGROK_URL",
  "NODE_EXTRA_CA_CERTS",
  "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS",
];
const portlessMutatedKeys = ["PATH", ...portlessInjectedKeys];

function disabled(value) {
  return value === "0" || value === "false" || value === "skip";
}

function ci(value) {
  return value !== undefined && !disabled(value);
}

export function shouldBootstrapPortless(args, env) {
  if (env[PORTLESS_CHILD] === "1" && !env.PORTLESS_URL)
    throw new PortlessConfigurationError("Portless did not provide its public URL");
  if (env.PORTLESS_URL || disabled(env.PORTLESS) || ci(env.CI)) return false;
  if (env.NODE_ENV === "production" || env.RAKAZO_DEPLOY_DIR || env.RAKAZO_COMPOSE_FILE)
    return false;
  return !args.some((arg) => ["--help", "--pi", "--setup-kit"].includes(arg));
}

function capturedEnvironment(env) {
  return Object.fromEntries(
    portlessMutatedKeys.map((key) => [
      key,
      Object.hasOwn(env, key) && env[key] !== undefined ? env[key] : null,
    ]),
  );
}

export function portlessLaunchPlan(root, args, caller, node = process.execPath) {
  const environment = {
    ...caller,
    [PORTLESS_CHILD]: "1",
    [PORTLESS_BASE_ENV]: JSON.stringify(capturedEnvironment(caller)),
    RAKAZO_DEV_PI_PATH: caller.RAKAZO_DEV_PI_PATH ?? caller.PATH,
  };
  return {
    command: node,
    args: [
      path.join(root, "node_modules", "portless", "dist", "cli.js"),
      "run",
      "--name",
      PORTLESS_NAME,
      node,
      path.join(root, "scripts", "dev.mjs"),
      ...args,
    ],
    environment,
  };
}

export function portlessPublicOrigin(env) {
  if (!env.PORTLESS_URL) return null;
  let url;
  try {
    url = new URL(env.PORTLESS_URL);
  } catch {
    throw new PortlessConfigurationError("Portless provided an invalid public URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new PortlessConfigurationError("Portless provided an invalid public URL");
  return url.origin;
}

function assignedPort(env) {
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new PortlessConfigurationError("Portless did not provide a valid application port");
  return String(port);
}

export function portlessServiceEnvironment(env) {
  const origin = portlessPublicOrigin(env);
  if (!origin) return { ...env };
  const service = {
    ...env,
    WEB_ORIGIN: origin,
    BETTER_AUTH_URL: origin,
    WEB_PORT: assignedPort(env),
  };
  delete service.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS;
  delete service[PORTLESS_CHILD];
  delete service[PORTLESS_BASE_ENV];
  return service;
}

function restoreCapturedEnvironment(env, restored) {
  if (!env[PORTLESS_BASE_ENV]) {
    for (const key of portlessInjectedKeys) delete restored[key];
    return;
  }
  let captured;
  try {
    captured = JSON.parse(env[PORTLESS_BASE_ENV]);
  } catch {
    throw new PortlessConfigurationError("Portless launch environment is invalid");
  }
  if (!captured || typeof captured !== "object" || Array.isArray(captured))
    throw new PortlessConfigurationError("Portless launch environment is invalid");
  for (const key of portlessMutatedKeys) {
    const value = captured[key];
    if (value === null) delete restored[key];
    else if (typeof value === "string") restored[key] = value;
    else throw new PortlessConfigurationError("Portless launch environment is invalid");
  }
}

export function portlessWorkerEnvironment(env) {
  if (!env.PORTLESS_URL && env[PORTLESS_CHILD] !== "1") return { ...env };
  const restored = { ...env };
  restoreCapturedEnvironment(env, restored);
  delete restored[PORTLESS_CHILD];
  delete restored[PORTLESS_BASE_ENV];
  return restored;
}
