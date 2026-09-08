import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { prepareWorkerDatabase } from "../../../scripts/dev.mjs";

const statusArgs = ["run", "--cwd", "packages/db", "prisma", "migrate", "status"];
const errorCopy =
  "Migrations are not verified up to date while a worker exists. Run node scripts/dev-worker.mjs stop, wait until node scripts/dev-worker.mjs status reports stopped, then run bun dev. Nothing was stopped.";

function fixture(state: string, result: { code: number | null; output: string } | Error) {
  const events: string[] = [];
  const root = "/synthetic-checkout";
  const env = {};
  const control = vi.fn(async () => {
    events.push("worker:status");
    return { state };
  });
  const run = vi.fn(async (_command: string, args: string[]) => {
    events.push(args.join(" "));
    if (args.at(-1) === "status" && result instanceof Error) throw result;
    return result;
  });
  return { options: { root, env, control, runner: { run } }, control, run, events };
}

describe("dev worker migration safety", () => {
  it("generates then deploys when no worker exists", async () => {
    const f = fixture("stopped", { code: 0, output: "" });
    await prepareWorkerDatabase(f.options);
    expect(f.events).toEqual(["worker:status", "run db:generate", "run db:migrate"]);
    expect(f.run.mock.calls).toEqual([
      ["bun", ["run", "db:generate"]],
      ["bun", ["run", "db:migrate"], { capture: true }],
    ]);
    expect(f.control.mock.calls).toEqual([
      [{ root: f.options.root, env: f.options.env }, "status"],
    ]);
  });

  it.each(["ready", "starting", "draining", "failed"])(
    "retains a %s worker with up-to-date migrations and checks before generation",
    async (state) => {
      const f = fixture(state, { code: 0, output: "Database schema is up to date!" });
      await prepareWorkerDatabase(f.options);
      expect(f.events).toEqual(["worker:status", statusArgs.join(" "), "run db:generate"]);
      expect(f.run).toHaveBeenNthCalledWith(1, "bun", statusArgs, {
        allowFailure: true,
        capture: true,
      });
      expect(f.control).toHaveBeenCalledExactlyOnceWith(
        { root: f.options.root, env: f.options.env },
        "status",
      );
    },
  );

  it.each([
    { code: 1, output: "Pending migrations" },
    { code: 1, output: "Migration histories diverge" },
    { code: 1, output: "Database unavailable" },
    { code: null, output: "" },
    new Error("Runner failed"),
  ])("fails closed without generation, deploy or stop on %j", async (result) => {
    const f = fixture("ready", result);
    await expect(prepareWorkerDatabase(f.options)).rejects.toThrow(errorCopy);
    expect(f.events).toEqual(["worker:status", statusArgs.join(" ")]);
    expect(f.control).toHaveBeenCalledExactlyOnceWith(
      { root: f.options.root, env: f.options.env },
      "status",
    );
  });

  it.each(["unreachable", "foreign"])(
    "preserves %s control failures without running commands",
    async (reason) => {
      const f = fixture("ready", { code: 0, output: "" });
      const error = new Error(reason);
      f.control.mockRejectedValueOnce(error);
      await expect(prepareWorkerDatabase(f.options)).rejects.toBe(error);
      expect(f.run).not.toHaveBeenCalled();
      expect(f.control).toHaveBeenCalledTimes(1);
    },
  );

  it("wires the guard after authentication and before worker startup", async () => {
    const source = await readFile(new URL("../../../scripts/dev.mjs", import.meta.url), "utf8");
    const bootstrap = source.slice(source.indexOf("export async function bootstrap("));
    const guard = bootstrap.indexOf("await prepareWorkerDatabase({ root, env, runner })");
    expect(guard).toBeGreaterThan(bootstrap.indexOf('await client.query("SELECT 1")'));
    expect(guard).toBeLessThan(bootstrap.indexOf("await ensureWorker({ root, env })"));
    expect(bootstrap).not.toContain('"db:generate"');
    expect(bootstrap).not.toContain('"db:migrate"');
  });
});
