import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AgentProcessHost, AgentProcessIdentity } from "./agent-process.js";
import { hasValidBearerToken } from "./supervisor-logic.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const identitySchema = z.object({ runId: id, botId: id, spaceId: id }).strict();
const inputSchema = z
  .object({ channel: z.enum(["rpc", "bridge"]), data: z.string().max(16 * 1024 * 1024) })
  .strict();

export function agentProcessRoutes(
  host: Pick<AgentProcessHost, "start" | "send" | "events" | "remove">,
  token: string,
) {
  const app = new Hono<{ Variables: { identity: AgentProcessIdentity } }>();
  app.use("*", async (c, next) => {
    if (!hasValidBearerToken(c.req.header("authorization"), token))
      return c.json({ error: "unauthorized" }, 401);
    const parsed = identitySchema.safeParse({
      runId: c.req.header("x-rakazo-run-id"),
      botId: c.req.header("x-rakazo-bot-id"),
      spaceId: c.req.header("x-rakazo-space-id"),
    });
    if (!parsed.success) return c.json({ error: "invalid agent identity" }, 400);
    c.set("identity", parsed.data);
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 17 * 1024 * 1024 }));
  app.post("/", async (c) => {
    const parsed = identitySchema.safeParse(await c.req.json().catch(() => undefined));
    const identity = c.get("identity");
    if (
      !parsed.success ||
      parsed.data.runId !== identity.runId ||
      parsed.data.botId !== identity.botId ||
      parsed.data.spaceId !== identity.spaceId
    ) {
      return c.json({ error: "invalid agent identity" }, 400);
    }
    try {
      return c.json(await host.start(identity), 201);
    } catch {
      return c.json({ error: "Isolated agent runtime unavailable" }, 503);
    }
  });
  app.post("/:id/input", async (c) => {
    const parsed = inputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid agent input" }, 400);
    try {
      await host.send(c.req.param("id"), c.get("identity"), parsed.data.channel, parsed.data.data);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Agent input unavailable" }, 409);
    }
  });
  app.get("/:id/events", async (c) => {
    const raw = c.req.query("cursor") ?? "-1";
    if (!/^-?\d+$/.test(raw)) return c.json({ error: "invalid cursor" }, 400);
    try {
      return c.json(
        await host.events(c.req.param("id"), c.get("identity"), Number(raw), c.req.raw.signal),
      );
    } catch {
      return c.json({ error: "Agent events unavailable" }, 404);
    }
  });
  app.delete("/:id", async (c) => {
    try {
      await host.remove(c.req.param("id"), c.get("identity"));
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Agent process unavailable" }, 404);
    }
  });
  return app;
}
