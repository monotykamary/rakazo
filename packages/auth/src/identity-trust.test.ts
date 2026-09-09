import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { bootstrapUserSpace } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTrustedOrigins, createAuth } from "./index.js";

// Exercise Better Auth's real routing, password hashing, verification and
// session hooks with its official offline adapter. Only persistence is faked.
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@rakazo/db", () => ({ bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })) }));

function fixture({
  allowlist = "",
  delivery = true,
  baseURL = "http://auth.example.test",
  webOrigin = "http://web.example.test",
  requestOrigin,
}: {
  allowlist?: string;
  delivery?: boolean;
  baseURL?: string;
  webOrigin?: string;
  requestOrigin?: string;
} = {}) {
  const data: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const policy = {
    signupsEnabled: true,
    signupAllowlist: allowlist,
    signupPolicyInitialized: true,
  };
  const messages: TransactionalEmail[] = [];
  const members = new Set<string>();
  const prisma = {
    authData: data,
    deploymentSettings: { findUnique: vi.fn(async () => policy) },
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        members.has(where.userId) ? { spaceId: "space-1" } : null,
      ),
    },
  };
  vi.mocked(bootstrapUserSpace).mockImplementation(async (_prisma, user) => {
    members.add(user.id);
    return { spaceId: "space-1" };
  });
  const auth = createAuth(prisma as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL,
    webOrigin,
    signupsEnabled: "true",
    signupAllowlist: "",
    email: delivery
      ? {
          describe: () => ({
            id: "offline-email",
            contractVersion: "1",
            adapterVersion: "1",
            capabilities: { transactional: true },
          }),
          send: async (message) => {
            messages.push(message);
          },
        }
      : undefined,
  });
  const request = async (path: string, body?: unknown, token?: string) => {
    // Better Auth disables origin checks under NODE_ENV=test; exercise production enforcement.
    (await auth.$context).skipOriginCheck = false;
    return auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          origin: requestOrigin ?? webOrigin,
          // Better Auth checks browser origins on cookie-bearing requests.
          ...(requestOrigin ? { cookie: "origin-probe=1" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  };
  const signup = (email = "approved@example.test") =>
    request("/sign-up/email", {
      email,
      password: "offline-password12",
      name: "Test User",
      emailVerified: true,
      id: "msg-attacker-chosen-id",
    });
  const signin = (email = "approved@example.test") =>
    request("/sign-in/email", {
      email,
      password: "offline-password12",
    });
  const verify = () => {
    const url = new URL(messages.at(-1)!.text.match(/http:\/\/\S+/)![0]);
    return request(`${url.pathname.replace("/api/auth", "")}${url.search}`);
  };
  return { auth, request, signup, signin, verify, data, policy, messages, members };
}

beforeEach(() => vi.clearAllMocks());

describe("named development origins", () => {
  it.each(["https://rakazo.localhost", "https://rakazo.test"])(
    "accepts authentication through the configured proxy origin %s",
    async (origin) => {
      const f = fixture({
        delivery: false,
        baseURL: origin,
        webOrigin: origin,
        requestOrigin: origin,
      });
      const response = await f.signup();
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("Secure");
      expect((await f.signin()).status).toBe(200);
      expect(buildTrustedOrigins({ baseURL: origin, webOrigin: origin })).toEqual([origin]);
    },
  );

  it.each([
    "https://other.localhost",
    "https://rakazo.localhost.example.test",
    "http://rakazo.localhost",
  ])("does not broaden trust to %s", async (requestOrigin) => {
    const origin = "https://rakazo.localhost";
    const f = fixture({ delivery: false, baseURL: origin, webOrigin: origin, requestOrigin });
    expect((await f.signup()).status).toBe(403);
    expect(f.data.user).toHaveLength(0);
  });
});

describe("loopback trusted origins", () => {
  it.each([
    ["http://127.0.0.1:5173", "http://localhost:5173"],
    ["http://localhost:5173", "http://127.0.0.1:5173"],
    ["https://localhost:45173", "https://127.0.0.1:45173"],
  ])("accepts the exact twin of %s", async (webOrigin, requestOrigin) => {
    const f = fixture({ delivery: false, baseURL: webOrigin, webOrigin, requestOrigin });
    expect((await f.signup()).status).toBe(200);
  });

  it.each([
    "https://localhost:5173",
    "http://localhost:5174",
    "http://[::1]:5173",
    "http://192.168.1.2:5173",
    "http://localhost.example.test:5173",
    "http://127.0.0.2:5173",
  ])("rejects unauthorized origin %s", async (requestOrigin) => {
    const f = fixture({
      delivery: false,
      baseURL: "http://127.0.0.1:5173",
      webOrigin: "http://127.0.0.1:5173",
      requestOrigin,
    });
    expect((await f.signup()).status).toBe(403);
    expect(f.data.user).toHaveLength(0);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it.each([
    "http://[::1]:5173",
    "http://127.1:5173",
    "http://0x7f000001:5173",
    "http://localhost.:5173",
    "http://localhost.example.test:5173",
    "http://192.168.1.2:5173",
    "not a URL",
  ])("does not expand %s", (origin) => {
    expect(buildTrustedOrigins({ webOrigin: origin, baseURL: origin })).toEqual([origin]);
  });

  it("preserves explicit extra origins without expanding them, and twins the auth base", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "https://web.example.test",
        baseURL: "https://localhost:444",
        extraOrigins: ["http://localhost:777", "https://web.example.test"],
      }),
    ).toEqual([
      "https://web.example.test",
      "https://localhost:444",
      "http://localhost:777",
      "https://127.0.0.1:444",
    ]);
  });
});

describe("identity trust through auth endpoints", () => {
  it("keeps first-owner bootstrap and password signup available without email for open deployments", async () => {
    const f = fixture({ delivery: false });
    const response = await f.signup();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      user: { id: string; emailVerified: boolean };
    };
    expect(body.token).toEqual(expect.any(String));
    expect(body.user.emailVerified).toBe(false);
    expect(body.user.id).not.toBe("msg-attacker-chosen-id");
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect((await f.signin()).status).toBe(200);
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a matching allowlisted address when email delivery is unavailable", async () => {
    const f = fixture({ allowlist: "@example.test", delivery: false });
    expect((await f.signup()).status).toBe(400);
    expect(f.data.user).toHaveLength(0);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("requires mailbox proof before creating a session, space or first-owner claim", async () => {
    const f = fixture({ allowlist: "approved@example.test" });
    expect((await f.signup("outsider@example.test")).status).toBe(400);
    const response = await f.signup();
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({ token: null, user: { emailVerified: false } });
    expect(f.data.session).toHaveLength(0);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    expect((await f.signin()).status).toBe(403);
    expect(f.messages).toHaveLength(2);
    expect((await f.request("/verify-email?token=forged-token")).status).not.toBe(200);
    expect(f.data.user![0]!.emailVerified).toBe(false);
    const verified = await f.verify();
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("http://web.example.test/sign-in");
    expect(verified.headers.get("set-cookie")).toBeNull();
    expect(f.data.user![0]!.emailVerified).toBe(true);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    const signedIn = await f.signin();
    expect(signedIn.status).toBe(200);
    const { token } = (await signedIn.json()) as { token: string };
    expect(token).toEqual(expect.any(String));
    expect(bootstrapUserSpace).toHaveBeenCalledTimes(1);
    expect(
      await f.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }),
    ).toMatchObject({ user: { emailVerified: true } });
  });

  it("rechecks policy before admitting a verified but unprovisioned signup", async () => {
    const f = fixture({ allowlist: "@example.test" });
    await f.signup();
    await f.verify();
    f.policy.signupsEnabled = false;
    expect((await f.signin()).status).toBe(403);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
    f.policy.signupsEnabled = true;
    f.policy.signupAllowlist = "someone-else@example.test";
    expect((await f.signin()).status).toBe(403);
    expect(bootstrapUserSpace).not.toHaveBeenCalled();
  });

  it("gates existing unverified sessions and auth mutations when the live allowlist is enabled", async () => {
    const f = fixture();
    const signedUp = await f.signup();
    const cookie = signedUp.headers.get("set-cookie")!.split(";")[0]!;
    const { token } = (await signedUp.json()) as { token: string };
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
    f.policy.signupAllowlist = "@example.test";
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    expect(await (await f.request("/get-session", undefined, token)).json()).toBeNull();
    expect(
      await f.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }),
    ).toBeNull();
    expect((await f.request("/update-user", { name: "Changed" }, token)).status).toBe(401);
    expect((await f.signin()).status).toBe(403);
    await f.verify();
    expect((await f.signin()).status).toBe(200);
  });

  it("does not leak request-local verification settings when signup policy changes", async () => {
    const f = fixture({ allowlist: "@example.test" });
    expect(await (await f.signup()).json()).toMatchObject({ token: null });
    f.policy.signupAllowlist = "";
    expect(await (await f.signup("open@example.test")).json()).toMatchObject({
      token: expect.any(String),
    });
    expect(f.messages).toHaveLength(1);
    f.policy.signupAllowlist = "@example.test";
    expect(await (await f.signup("restricted@example.test")).json()).toMatchObject({ token: null });
    expect(f.messages).toHaveLength(2);
  });

  it("reserves internal messaging emails across registration, recovery and email changes", async () => {
    const f = fixture();
    for (const email of [
      "msg-sendblue15550001111@messaging.invalid",
      "MSG-Test@MESSAGING.INVALID",
    ]) {
      expect((await f.signup(email)).status).toBe(400);
      expect((await f.signin(email)).status).toBe(400);
      expect((await f.request("/request-password-reset", { email })).status).toBe(400);
      expect((await f.request("/send-verification-email", { email })).status).toBe(400);
    }
    expect(f.data.user).toHaveLength(0);
    const { token } = (await (await f.signup()).json()) as { token: string };
    expect(
      (await f.request("/change-email", { newEmail: "msg-taken@messaging.invalid" }, token)).status,
    ).toBe(400);
    // An account preclaimed before this upgrade must not keep its session.
    f.data.user![0]!.email = "msg-taken@messaging.invalid";
    expect(await (await f.request("/get-session", undefined, token)).json()).toBeNull();
    expect((await f.request("/update-user", { name: "Changed" }, token)).status).toBe(401);
    expect(f.messages).toHaveLength(0);
  });
});
