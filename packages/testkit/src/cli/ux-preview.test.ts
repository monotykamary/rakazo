import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  localPreviewDatabaseUrl,
  previewPort,
  previewScript,
  waitForPreviewServer,
} from "./ux-preview.js";

describe("local UX preview boundaries", () => {
  it("replaces inferred peer scripts without changing normal user scripts", () => {
    const script = [{ assistant: "Explicit fixture", complete: true }];
    expect(previewScript("[bot] Internal routing envelope")).toEqual([
      { assistant: "The Atlas review is ready.", complete: true },
    ]);
    expect(
      previewScript("[bot] Internal routing envelope", [
        { assistant: "done. i handled: [bot] Internal routing envelope", complete: true },
      ]),
    ).toEqual([{ assistant: "The Atlas review is ready.", complete: true }]);
    expect(previewScript("A normal user request", script)).toBe(script);
    expect(previewScript("A normal user request")).toBeUndefined();
  });

  it("waits for its own authenticated web stack, not an existing HTML server", async () => {
    const seenTokens: Array<string | string[] | undefined> = [];
    const rejected = new AbortController();
    let wrongRequests = 0;
    const server = createServer((request, response) => {
      expect(request.url).toBe("/.well-known/rakazo-desktop-stack");
      seenTokens.push(request.headers["x-rakazo-desktop-stack-token"]);
      const matches = request.headers["x-rakazo-desktop-stack-token"] === "fixture-token";
      response.setHeader("content-type", matches ? "application/json" : "text/html");
      response.end(
        matches ? JSON.stringify({ ok: true, imageTag: "ux-preview" }) : "<html>Old server</html>",
      );
      if (!matches && ++wrongRequests === 2) rejected.abort();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(
        waitForPreviewServer(
          origin,
          "unrelated-token",
          AbortSignal.any([rejected.signal, AbortSignal.timeout(10_000)]),
        ),
      ).resolves.toBe(false);
      await expect(
        waitForPreviewServer(origin, "fixture-token", AbortSignal.timeout(10_000)),
      ).resolves.toBe(true);
      expect(seenTokens).toContain("unrelated-token");
      expect(seenTokens).toContain("fixture-token");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not wait for readiness after shutdown", async () => {
    await expect(
      waitForPreviewServer("http://127.0.0.1:1", "fixture-token", AbortSignal.abort()),
    ).resolves.toBe(false);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("uses the local admin database on %s", (host) => {
    const result = localPreviewDatabaseUrl(
      `postgresql://fixture:fake@${host}:5432/keep_me?schema=public`,
    );
    expect(result.hostname).toBe(host);
    expect(result.pathname).toBe("/postgres");
    expect(result.search).toBe("");
    expect(result.port).toBe("5432");
  });

  it.each([
    "postgresql://database.example.test/app",
    "postgresql://127.0.0.1.example.test/app",
    "https://127.0.0.1/app",
    "postgresql://localhost/app?host=database.example.test",
    "postgresql://localhost/app?hostaddr=192.0.2.1",
    "postgresql://localhost/app?options=-csearch_path=private",
    "postgresql://localhost/app?schema=private",
  ])("rejects remote targets and connection overrides: %s", (value) => {
    expect(() => localPreviewDatabaseUrl(value)).toThrow();
  });

  it("uses defaults and validates explicit ports", () => {
    expect(previewPort(undefined, 5294)).toBe(5294);
    expect(previewPort("3219", 5294)).toBe(3219);
  });

  it.each(["", "0", "80", "65536", "5294.5", "not-a-port"])("rejects invalid port %s", (value) => {
    expect(() => previewPort(value, 5294)).toThrow();
  });
});
