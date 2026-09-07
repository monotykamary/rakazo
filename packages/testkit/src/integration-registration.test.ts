import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("finishes a package's generation before typechecking its generated sources", () => {
  const config = JSON.parse(readFileSync(new URL("../../../turbo.json", import.meta.url), "utf8"));
  expect(config.tasks.check.dependsOn).toContain("generate");
});

it("registers every PostgreSQL suite in the isolated integration harness", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const suites = globSync(
    ["packages/*/src/**/*.postgres.test.ts", "apps/*/src/**/*.postgres.test.ts"],
    { cwd: root },
  );
  const harness = readFileSync(new URL("./cli/harness.ts", import.meta.url), "utf8");
  expect(suites.length).toBeGreaterThan(0);
  for (const suite of suites)
    expect(harness).toContain(JSON.stringify(suite.replaceAll("\\", "/")));
});
