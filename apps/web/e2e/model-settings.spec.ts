import { expect, test } from "@playwright/test";
import type { ModelSelection, ModelSelectionStatus } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

const current: ModelSelection = {
  provider: "custom-extension",
  modelId: "actual-running-v2",
  thinkingLevel: "low",
};
const stale: ModelSelection = {
  provider: "removed-provider",
  modelId: "retired-model",
  thinkingLevel: "high",
};
const catalog = [
  {
    provider: "custom-extension",
    id: "actual-running-v2",
    label: "Extension current",
    billing: "",
    thinkingLevels: ["off", "low"],
  },
  {
    provider: "private-extension",
    id: "custom-research-2026",
    label: "Research",
    billing: "",
    thinkingLevels: ["low", "high"],
  },
  { provider: "plain-provider", id: "basic", label: "Basic", billing: "" },
];
function snapshot(
  status: ModelSelectionStatus = {
    requested: stale,
    effective: current,
    status: "applied",
    error: null,
  },
) {
  return {
    catalog,
    profileDefault: { ...current, modelId: "profile-startup" },
    current,
    selection: status,
    availability: { status: "available", error: null },
  };
}

test("global inventory searches extension identities and labels only the Pi profile default", async ({
  page,
}, testInfo) => {
  const calls: string[] = [];
  await page.route("**/rpc/**", async (route) => {
    calls.push(new URL(route.request().url()).pathname);
    expect(route.request().postDataJSON().json).toEqual({});
    await route.fulfill({ json: { json: { ...snapshot(), current: null, selection: null } } });
  });
  await page.goto("/e2e/fixtures/pi-models.html");
  await expect(page.getByTestId("pi-profile-default")).toHaveText(
    "Pi profile default: custom-extension/profile-startup",
  );
  await page.getByRole("combobox", { name: "Search models" }).fill("custom-research-2026");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText("private-extension/custom-research-2026");
  await page.getByRole("option").click();
  await expect(page.getByTestId("selected-model")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Search models" }).press("Enter");
  await expect(page.getByTestId("selected-model")).toHaveCount(0);
  await expect(page.getByTestId("pi-profile-default")).toHaveText(
    "Pi profile default: custom-extension/profile-startup",
  );
  await expect(
    page.getByRole("button", { name: /Use model|Connect|API key|Visibility|Rotation/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toHaveCount(0);
  expect(calls).toEqual(["/rpc/models/runtime"]);
  await captureScreenshot(page, testInfo, "pi-model-inventory-search");
});

test("worker preserves unavailable intent, shows actual current, and handles pending and failed switches", async ({
  page,
}, testInfo) => {
  let status: ModelSelectionStatus = {
    requested: stale,
    effective: current,
    status: "applied",
    error: null,
  };
  let failWrite = false;
  await page.route("**/rpc/models/runtime", async (route) => {
    expect(route.request().postDataJSON().json).toEqual({
      botId: "bot-fixture",
      threadId: "thread-fixture",
      participantId: "worker-fixture",
    });
    await route.fulfill({ json: { json: snapshot(status) } });
  });
  await page.route("**/rpc/models/setWorkerSelection", async (route) => {
    if (failWrite) return route.fulfill({ status: 503, body: "Unavailable" });
    status = {
      requested: route.request().postDataJSON().json.selection,
      effective: current,
      status: "pending",
      error: null,
    };
    await route.fulfill({ json: { json: status } });
  });
  await page.goto("/e2e/fixtures/pi-models.html?worker");
  await expect(page.getByTestId("selected-model")).toHaveText(
    "Selected: removed-provider/retired-model · Unavailable",
  );
  await expect(page.getByTestId("current-model")).toHaveText(
    "Current: custom-extension/actual-running-v2 · low",
  );
  await expect(page.getByRole("button", { name: "Use model", exact: true })).toBeDisabled();
  await captureScreenshot(page, testInfo, "pi-model-unavailable-selection");
  await page.getByRole("combobox", { name: "Search models" }).fill("research");
  await page.getByRole("option").click();
  await page.getByRole("combobox", { name: "Thinking", exact: true }).selectOption("high");
  await page.getByRole("button", { name: "Use model", exact: true }).click();
  await expect(
    page.getByText("Pending · private-extension/custom-research-2026", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("current-model")).toContainText(
    "custom-extension/actual-running-v2",
  );
  await captureScreenshot(page, testInfo, "pi-model-switch-pending");
  status = { ...status, status: "failed", error: "Model unavailable" };
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Model unavailable");
  failWrite = true;
  await page.getByRole("button", { name: "Use model", exact: true }).click();
  await expect(page.getByText("Could not switch model", { exact: true })).toBeVisible();
  await expect(page.getByTestId("selected-model")).toContainText(
    "private-extension/custom-research-2026",
  );
});

test("failed and delayed refresh preserve draft; reasoning follows Pi capabilities", async ({
  page,
}) => {
  let fail = false;
  let release: (() => void) | undefined;
  let delay = false;
  await page.route("**/rpc/models/runtime", async (route) => {
    if (delay)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (fail) return route.fulfill({ status: 503, body: "Unavailable" });
    await route.fulfill({ json: { json: snapshot() } });
  });
  await page.goto("/e2e/fixtures/pi-models.html?worker");
  await expect(page.getByTestId("selected-model")).toContainText("retired-model");
  delay = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill("basic");
  await page.getByRole("option").click();
  await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toHaveCount(0);
  await expect.poll(() => Boolean(release)).toBe(true);
  release!();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await expect(page.getByTestId("selected-model")).toHaveText("Selected: plain-provider/basic");
  delay = false;
  fail = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Could not refresh models");
  await expect(page.getByTestId("selected-model")).toHaveText("Selected: plain-provider/basic");
});

for (const available of [false, true]) {
  test(`empty catalog is safe (${available ? "connected" : "disconnected"})`, async ({ page }) => {
    await page.route("**/rpc/models/runtime", (route) =>
      route.fulfill({
        json: {
          json: {
            ...snapshot(),
            catalog: [],
            current: null,
            selection: null,
            availability: { status: available ? "available" : "unavailable", error: null },
          },
        },
      }),
    );
    await page.goto("/e2e/fixtures/pi-models.html?worker");
    await expect(
      page.getByText(available ? "No models available" : "Pi unavailable", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Use model", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  });
}

test("bot picker uses authorized bot runtime and preserves stale intent on unrelated saves", async ({
  page,
}, testInfo) => {
  const writes: Record<string, unknown>[] = [];
  let fail = false;
  await page.route("**/rpc/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/rpc/models/runtime") {
      expect(route.request().postDataJSON().json).toEqual({ botId: "bot-fixture" });
      return route.fulfill({ json: { json: snapshot() } });
    }
    if (path === "/rpc/bots/update") {
      writes.push(route.request().postDataJSON().json);
      if (fail) return route.fulfill({ status: 503, body: "Unavailable" });
      return route.fulfill({ json: { json: {} } });
    }
    return route.fulfill({ status: 503, body: "Offline fixture" });
  });
  await page.goto("/e2e/fixtures/pi-models.html?bot");
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByTestId("current-model")).toContainText(
    "custom-extension/actual-running-v2",
  );
  await expect(page.getByTestId("selected-model")).toContainText(
    "removed-provider/retired-model · Unavailable",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).not.toHaveProperty("modelId");
  expect(writes[0]).not.toHaveProperty("thinkingLevel");
  await page.getByRole("combobox", { name: "Search models" }).fill("custom-research-2026");
  await page.getByRole("option").click();
  await page.getByRole("combobox", { name: "Thinking", exact: true }).selectOption("high");
  fail = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({
    modelProvider: "private-extension",
    modelId: "custom-research-2026",
    thinkingLevel: "high",
  });
  await expect(page.getByTestId("selected-model")).toContainText(
    "private-extension/custom-research-2026",
  );
  await captureScreenshot(page, testInfo, "pi-bot-model-picker");
});

test("unsupported persisted thinking stays visible and switching does not claim success early", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const requested = {
    provider: "plain-provider",
    modelId: "basic",
    thinkingLevel: "high" as const,
  };
  await page.route("**/rpc/models/runtime", (route) =>
    route.fulfill({
      json: { json: snapshot({ requested, effective: current, status: "applied", error: null }) },
    }),
  );
  await page.route("**/rpc/models/setWorkerSelection", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ status: 503, body: "Unavailable" });
  });
  await page.goto("/e2e/fixtures/pi-models.html?worker");
  await expect(page.getByText("Thinking: high · Unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use model", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Search models" }).fill("research");
  await page.getByRole("option").click();
  await page.getByRole("button", { name: "Use model", exact: true }).click();
  await expect(page.getByRole("button", { name: "Switching…", exact: true })).toBeDisabled();
  await expect(page.getByTestId("current-model")).toContainText(
    "custom-extension/actual-running-v2",
  );
  await expect.poll(() => Boolean(release)).toBe(true);
  release!();
  await expect(page.getByText("Could not switch model", { exact: true })).toBeVisible();
  await expect(page.getByTestId("selected-model")).toContainText(
    "private-extension/custom-research-2026",
  );
});

for (const participant of [true, false]) {
  test(`clearing ${participant ? "worker" : "root"} intent labels its inheritance honestly`, async ({
    page,
  }) => {
    let written: unknown;
    await page.route("**/rpc/models/runtime", (route) =>
      route.fulfill({ json: { json: snapshot() } }),
    );
    await page.route("**/rpc/models/setWorkerSelection", async (route) => {
      written = route.request().postDataJSON().json;
      await route.fulfill({
        json: { json: { requested: null, effective: current, status: "pending", error: null } },
      });
    });
    await page.goto(`/e2e/fixtures/pi-models.html?worker${participant ? "" : "&root"}`);
    await page
      .getByRole("button", {
        name: participant ? "Use bot model" : "Use Pi selection",
        exact: true,
      })
      .click();
    await expect
      .poll(() => written)
      .toEqual({
        botId: "bot-fixture",
        threadId: "thread-fixture",
        ...(participant ? { participantId: "worker-fixture" } : {}),
        selection: null,
      });
    await expect(page.getByTestId("current-model")).toContainText(
      "custom-extension/actual-running-v2",
    );
    await expect(page.getByRole("button", { name: "Use Pi default", exact: true })).toHaveCount(0);
  });
}
