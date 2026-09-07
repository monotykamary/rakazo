import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("peer view loads one filtered page and earlier history only on request", async ({
  page,
}, testInfo) => {
  const requests: unknown[] = [];
  let failEarlier = true;
  await page.route("**/rpc/threads/messages", (route) => {
    const input = route.request().postDataJSON().json;
    requests.push(input);
    expect(input.botId).toBe("bot");
    expect(input.peerBotId).toBe("peer");
    expect(input.includePeerRuns).toBeUndefined();
    if (input.before && failEarlier) {
      failEarlier = false;
      return route.fulfill({ status: 500, json: { error: "offline" } });
    }
    const seq = input.before ? 1 : 50;
    return route.fulfill({
      json: {
        json: {
          threadId: "thread",
          olderCursor: input.before ? null : 50,
          messages: [
            {
              id: `message-${seq}`,
              threadId: "thread",
              botId: "bot",
              seq,
              role: "system",
              createdAt: "2026-09-01T00:00:00Z",
              blocks: [
                {
                  kind: "bot_message_sent",
                  toBotId: "peer",
                  toBotName: "Research",
                  text: input.before ? "Earlier request" : "Latest request",
                },
              ],
            },
          ],
        },
      },
    });
  });
  await page.goto("/e2e/fixtures/peer-visibility.html");
  await page.getByRole("button", { name: "Open peer", exact: true }).click();
  const view = page.getByTestId("peer-conversation-view");
  await expect(view.getByText("Latest request", { exact: true })).toBeVisible();
  await expect(view.getByRole("button", { name: "Load earlier", exact: true })).toBeEnabled();
  expect(requests).toEqual([{ botId: "bot", peerBotId: "peer" }]);
  await view.getByRole("button", { name: "Load earlier", exact: true }).click();
  await expect(view.getByRole("alert")).toBeVisible();
  await expect(view.getByText("Latest request", { exact: true })).toBeVisible();
  await view.getByRole("button", { name: "Load earlier", exact: true }).click();
  await expect(view.getByText("Earlier request", { exact: true })).toBeVisible();
  await expect(view.getByRole("button", { name: "Load earlier", exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(3);
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "bounded-peer-history");
});

test("hidden worker pin stays unavailable without silently selecting another model", async ({
  page,
}) => {
  const requested = { provider: "local", modelId: "hidden-model", thinkingLevel: null };
  await page.route("**/rpc/models/getVisibility", (route) =>
    route.fulfill({ json: { json: { hide: [{ provider: "local", model: "hidden-model" }] } } }),
  );
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "local",
            provider: "local",
            modelId: "hidden-model",
            label: "Local",
            hasKey: false,
            isDefault: true,
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/models/list", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            provider: "local",
            id: "visible-model",
            label: "Visible model",
            billing: "local",
            thinkingLevels: [],
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/models/getSelection", (route) =>
    route.fulfill({
      json: {
        json: {
          requested,
          effective: { ...requested, modelId: "visible-model" },
          status: "failed",
          error: "Model is hidden",
        },
      },
    }),
  );
  let writes = 0;
  await page.route("**/rpc/models/setWorkerSelection", (route) => {
    writes++;
    return route.fulfill({ status: 500 });
  });
  await page.goto("/e2e/fixtures/peer-visibility.html");
  await page.getByRole("button", { name: "Model", exact: true }).click();
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveValue("local::hidden-model");
  await expect(model.locator("option:checked")).toHaveText("hidden-model · Unavailable");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Use bot model", exact: true })).toBeEnabled();
  await expect(page.getByText("Effective: visible-model", { exact: true })).toBeVisible();
  expect(writes).toBe(0);
});

test("editing a bot title preserves its hidden pin and effort", async ({ page }) => {
  await page.route("**/rpc/**", (route) => {
    const method = new URL(route.request().url()).pathname.split("/rpc/")[1];
    const values: Record<string, unknown> = {
      "models/credentials": [
        {
          id: "local",
          provider: "local",
          modelId: "hidden-model",
          label: "Local",
          hasKey: true,
          isDefault: true,
        },
      ],
      "models/list": [],
      "models/getVisibility": { hide: [{ provider: "local", model: "hidden-model" }] },
      me: { defaultProvider: "local", defaultModel: "visible-model" },
      "voice/voices": [],
    };
    return route.fulfill({ json: { json: values[method ?? ""] ?? [] } });
  });
  await page.goto("/e2e/fixtures/peer-visibility.html");
  await page.getByRole("button", { name: "Open bot settings", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByLabel("Title", { exact: true }).fill("Reviewer");
  await settings.getByTestId("bot-settings-advanced").locator("summary").click();
  const model = settings.getByRole("combobox", { name: "Model", exact: true });
  await expect(model.locator("option:checked")).toHaveText("hidden-model · Unavailable");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { savedBotPatch?: unknown }).savedBotPatch),
    )
    .toMatchObject({
      title: "Reviewer",
      modelProvider: "local",
      modelId: "hidden-model",
      thinkingLevel: "high",
    });
});

test("advanced visibility hides and unhides exact model and provider identities", async ({
  page,
}, testInfo) => {
  let hide: { provider: string; model?: string }[] = [];
  let catalogReads = 0;
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "custom",
            provider: "custom",
            modelId: "actual-model",
            label: "Compatible",
            hasKey: true,
            isDefault: false,
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/models/getVisibility", (route) =>
    route.fulfill({ json: { json: { hide } } }),
  );
  await page.route("**/rpc/models/listForVisibility", (route) => {
    catalogReads++;
    return route.fulfill({
      json: {
        json: [
          {
            provider: "custom",
            id: "openai-compatible",
            label: "Compatible placeholder",
            placeholder: true,
          },
          { provider: "local", id: "small", label: "Small" },
          { provider: "local", id: "large", label: "Large" },
        ],
      },
    });
  });
  await page.route("**/rpc/models/setVisibility", (route) => {
    hide = route.request().postDataJSON().json.hide;
    return route.fulfill({ json: { json: { hide } } });
  });
  await page.goto("/e2e/fixtures/peer-visibility.html");
  expect(catalogReads).toBe(0);
  await page.locator("summary").filter({ hasText: "Visibility" }).click();
  await expect(
    page.getByRole("button", { name: "Hide Compatible placeholder", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Hide Compatible · actual-model", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide custom", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide Small", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unhide small", exact: true })).toBeVisible();
  expect(hide).toEqual([{ provider: "local", model: "small" }]);
  await page.getByRole("button", { name: "Hide local", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hide Large", exact: true })).toHaveCount(0);
  expect(hide).toEqual([{ provider: "local", model: "small" }, { provider: "local" }]);
  await captureScreenshot(page, testInfo, "advanced-model-visibility");
  await page.getByRole("button", { name: "Unhide local", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hide Large", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Unhide small", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hide Small", exact: true })).toBeVisible();
  expect(hide).toEqual([]);
});
