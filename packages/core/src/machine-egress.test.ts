import { describe, expect, it } from "vitest";
import {
  createEgressFrameReader,
  decodeEgressFrame,
  encodeEgressFrame,
  encodeEgressPacket,
  officeEgressProxyUrl,
  parseEgressTarget,
} from "./machine-egress.js";

describe("parseEgressTarget", () => {
  it("accepts DNS, IPv4, IPv6, and a default https port", () => {
    expect(parseEgressTarget("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseEgressTarget("example.com")).toEqual({ host: "example.com", port: 443 });
    expect(parseEgressTarget("127.0.0.1:8080")).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(parseEgressTarget("[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: 443 });
    expect(parseEgressTarget("localhost:9")).toEqual({ host: "localhost", port: 9 });
  });

  it("rejects credentials, paths, and unusable ports", () => {
    expect(parseEgressTarget("user:pass@example.com:443")).toBeNull();
    expect(parseEgressTarget("example.com:443/path")).toBeNull();
    expect(parseEgressTarget("example.com:0")).toBeNull();
    expect(parseEgressTarget("example.com:65536")).toBeNull();
    expect(parseEgressTarget("")).toBeNull();
    expect(parseEgressTarget("-bad.example:443")).toBeNull();
  });
});

describe("egress frames", () => {
  it("round-trips open, ready, data, and close", () => {
    const open = { type: "open" as const, id: 3, host: "example.com", port: 443 };
    expect(decodeEgressFrame(encodeEgressFrame(open))).toEqual(open);
    expect(decodeEgressFrame(encodeEgressFrame({ type: "ready", id: 3 }))).toEqual({
      type: "ready",
      id: 3,
    });
    const data = decodeEgressFrame(
      encodeEgressFrame({ type: "data", id: 3, bytes: new Uint8Array([1, 2, 9]) }),
    );
    expect(data).toMatchObject({ type: "data", id: 3 });
    expect(Array.from(data && data.type === "data" ? data.bytes : [])).toEqual([1, 2, 9]);
    expect(decodeEgressFrame(encodeEgressFrame({ type: "close", id: 3, error: "nope" }))).toEqual({
      type: "close",
      id: 3,
      error: "nope",
    });
  });

  it("reassembles length-prefixed packets split across chunks", () => {
    const frames: string[] = [];
    const errors: string[] = [];
    const reader = createEgressFrameReader(
      (frame) => frames.push(frame.type),
      (error) => errors.push(error.message),
    );
    const packet = encodeEgressPacket({ type: "ready", id: 1 });
    reader.push(packet.subarray(0, 3));
    reader.push(packet.subarray(3));
    expect(frames).toEqual(["ready"]);
    expect(errors).toEqual([]);
  });
});

describe("officeEgressProxyUrl", () => {
  it("points computers at the runner proxy on the docker host", () => {
    expect(officeEgressProxyUrl(18764)).toBe("http://host.docker.internal:18764");
  });
});
