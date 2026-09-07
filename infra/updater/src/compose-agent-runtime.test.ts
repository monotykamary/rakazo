import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Service = {
  image?: string;
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
};
const root = path.resolve(import.meta.dirname, "../../..");
function compose(name: string): { services: Record<string, Service> } {
  return parse(readFileSync(path.join(root, "infra/compose", name), "utf8"));
}
describe("managed agent image composition", () => {
  it.each(["docker-compose.prod.yml", "docker-compose.images.yml", "docker-compose.topology.yml"])(
    "uses the same pinned application image for isolated workers in %s",
    (name) => {
      const { services } = compose(name);
      expect(services.supervisor?.environment?.RAKAZO_AGENT_IMAGE).toBe(services.api?.image);
      expect(services.api?.environment?.SANDBOX_SUPERVISOR_URL).toBe("http://supervisor:7091");
      expect(services.worker?.environment?.SANDBOX_SUPERVISOR_URL).toBe("http://supervisor:7091");
    },
  );
  it("builds the development agent image before starting its supervisor", () => {
    const { services } = compose("docker-compose.yml");
    expect(services.supervisor?.environment?.RAKAZO_AGENT_IMAGE).toBe(services.agent?.image);
    expect(services.supervisor?.depends_on?.agent).toEqual({
      condition: "service_completed_successfully",
    });
  });
  it("updates an existing supervisor service rather than a nonexistent sidecar name", () => {
    const { services } = compose("docker-compose.prod.yml");
    const value = services.updater?.environment?.RAKAZO_UPDATE_SERVICES ?? "";
    const defaults = value.split(":-")[1]?.replace(/}$/, "").split(",") ?? [];
    expect(defaults).toContain("supervisor");
    for (const service of defaults) expect(services[service]).toBeDefined();
  });
  it("includes vendored workspace dependencies before installing the updater image", () => {
    const dockerfile = readFileSync(path.join(root, "infra/updater/Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}$/m);
    const copy = dockerfile.indexOf("COPY vendor/pi-kit vendor/pi-kit");
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(dockerfile.indexOf("RUN bun install --frozen-lockfile"));
    const core = JSON.parse(readFileSync(path.join(root, "packages/core/package.json"), "utf8"));
    const archive = core.dependencies["pi-queue-steer-factory"];
    expect(archive).toMatch(/^file:.*vendor\/pi-kit\//);
    expect(
      readFileSync(path.resolve(root, "packages/core", archive.slice(5))).length,
    ).toBeGreaterThan(0);
  });

  it("exposes one build command for both required local images", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts["sandbox:build"]).toContain("bun run sandbox:agent:build");
    expect(pkg.scripts["sandbox:agent:build"]).toContain("rakazo/agent:local");
    expect(pkg.scripts["pi:kit:check"]).toContain("scripts/check-pi-kit.ts");
  });
});
