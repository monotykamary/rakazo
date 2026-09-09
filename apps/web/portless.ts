export interface ViteNetworkEnvironment {
  PORT?: string;
  PORTLESS_URL?: string;
  WEB_PORT?: string;
}

function port(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
    throw new Error(`${name} must be a valid port`);
  return parsed;
}

export function viteDevNetwork(env: ViteNetworkEnvironment) {
  const internalPort = env.PORTLESS_URL
    ? port(env.PORT, "PORT")
    : port(env.WEB_PORT ?? "5173", "WEB_PORT");
  if (!env.PORTLESS_URL) return { port: internalPort };
  const publicUrl = new URL(env.PORTLESS_URL);
  if (!["http:", "https:"].includes(publicUrl.protocol))
    throw new Error("PORTLESS_URL must use HTTP or HTTPS");
  const secure = publicUrl.protocol === "https:";
  return {
    port: internalPort,
    allowedHosts: [publicUrl.hostname],
    hmr: {
      protocol: secure ? ("wss" as const) : ("ws" as const),
      host: publicUrl.hostname,
      clientPort: publicUrl.port ? port(publicUrl.port, "PORTLESS_URL port") : secure ? 443 : 80,
    },
  };
}
