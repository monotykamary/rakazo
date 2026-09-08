import { MACHINE_COMMAND_BODY_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { CommandRejectedError, validateCommand } from "./command-validation.js";

describe("command validation", () => {
  it("accepts null bodies from the actual durable mailbox wire format", () => {
    expect(
      validateCommand({
        method: "GET",
        path: "/computers/computer-1/files",
        headersJson: "{}",
        bodyBase64: null,
        contentType: null,
      }),
    ).toEqual({
      method: "GET",
      path: "/computers/computer-1/files",
      query: "",
      headers: {},
    });
    expect(() =>
      validateCommand({ method: "POST", path: "/agents", bodyBase64: "not-base64" }),
    ).toThrow("base64");
  });
  it("accepts supervisor commands on the fixed authority", () => {
    expect(
      validateCommand({
        method: "post",
        path: "/computers",
        headers: { "content-type": "application/json", "x-rakazo-bot-id": "home-key" },
        bodyBase64: Buffer.from(JSON.stringify({ botId: "home-key" })).toString("base64"),
      }),
    ).toMatchObject({
      method: "POST",
      path: "/computers",
      headers: { "x-rakazo-bot-id": "home-key" },
    });
    expect(
      validateCommand({ method: "GET", path: "/agents/a1/events", query: "cursor=2" }),
    ).toMatchObject({
      query: "cursor=2",
    });
  });

  it("rejects methods and paths outside the local supervisor authority", () => {
    expect(() => validateCommand({ method: "TRACE", path: "/computers" })).toThrow(/method/i);
    expect(() => validateCommand({ method: "GET", path: "/etc/passwd" })).toThrow(/authority/i);
    expect(() =>
      validateCommand({ method: "GET", path: "https://evil.example/computers" }),
    ).toThrow(/authority/i);
    expect(() => validateCommand({ method: "GET", path: "/computers/../../etc/passwd" })).toThrow();
    expect(() => validateCommand({ method: "GET", path: "/computers//id" })).toThrow();
    expect(() => validateCommand({ method: "GET", path: "/computers/%2e%2e" })).toThrow();
    expect(() => validateCommand({ method: "GET", path: `/${"a".repeat(3000)}` })).toThrow();
  });

  it("strips every header that is not an explicit passthrough", () => {
    const validated = validateCommand({
      method: "GET",
      path: "/agents/a1/events",
      headers: {
        authorization: "Bearer stolen",
        cookie: "session=stolen",
        "x-rakazo-bot-id": "home-key",
        "x-rakazo-lease-fence": "7",
        "content-type": "application/json",
        "x-arbitrary": "nope",
      },
    });
    expect(validated.headers).toEqual({
      "x-rakazo-bot-id": "home-key",
      "x-rakazo-lease-fence": "7",
    });
    expect(validated.contentType).toBe("application/json");
  });

  it("takes content-type from its dedicated field, not a free header", () => {
    const validated = validateCommand({
      method: "POST",
      path: "/computers",
      contentType: "application/json",
      headersJson: JSON.stringify({
        "x-rakazo-bot-id": "home-key",
        "content-type": "application/json",
      }),
    });
    expect(validated.headers).toEqual({ "x-rakazo-bot-id": "home-key" });
    expect(validated.contentType).toBe("application/json");
  });

  it("rejects oversized or malformed bodies and queries", () => {
    expect(() =>
      validateCommand({
        method: "POST",
        path: "/computers",
        bodyBase64: Buffer.alloc(MACHINE_COMMAND_BODY_MAX_BYTES + 1).toString("base64"),
      }),
    ).toThrow(/limit/i);
    expect(() =>
      validateCommand({ method: "GET", path: "/agents/a/events", query: "cursor=%2" }),
    ).toThrow(/query/i);
    expect(() =>
      validateCommand({ method: "GET", path: "/agents/a/events", query: "a=b;rm" }),
    ).toThrow(/query/i);
  });

  it("labels rejections with an HTTP status", () => {
    try {
      validateCommand({ method: "GET", path: "/nowhere" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CommandRejectedError);
      expect((error as CommandRejectedError).status).toBe(400);
    }
  });
});
