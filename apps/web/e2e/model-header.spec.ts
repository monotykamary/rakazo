import { expect, type Page, test } from "@playwright/test";
import { BOT_COLORS, type ModelRuntimeSnapshot, type ModelSelection } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

const current: ModelSelection = { provider: "fixture", modelId: "sol", thinkingLevel: "high" };
const next: ModelSelection = { provider: "fixture", modelId: "astra", thinkingLevel: "low" };
const catalog = [
  { provider: "fixture", id: "sol", label: "Sol", billing: "", thinkingLevels: ["high" as const] },
  {
    provider: "fixture",
    id: "astra",
    label: "Astra",
    billing: "",
    thinkingLevels: ["low" as const],
  },
];
async function mount(
  page: Page,
  options: {
    firstRun?: boolean;
    inherited?: boolean;
    fail?: boolean;
    delay?: boolean;
    group?: boolean;
  } = {},
) {
  let runtime: ModelRuntimeSnapshot = {
    catalog,
    profileDefault: current,
    current: options.firstRun ? null : current,
    selection: {
      requested: options.inherited ? null : current,
      effective: options.firstRun ? null : current,
      status: options.firstRun ? "pending" : "applied",
      error: null,
    },
    availability: { status: "available", error: null },
  };
  const writes: Record<string, unknown>[] = [];
  const paths: string[] = [];
  let release: (() => void) | undefined;
  const bot = {
    id: "bot-fixture",
    spaceId: "space-fixture",
    threadId: "thread-fixture",
    name: "Fixture bot",
    title: "",
    description: "",
    instructions: "",
    color: BOT_COLORS[0],
    status: "idle",
    computerMode: "shared",
    memoryScope: null,
    autoSpeak: false,
    voiceId: null,
    modelProvider: options.inherited ? null : current.provider,
    modelId: options.inherited ? null : current.modelId,
    thinkingLevel: options.inherited ? null : current.thinkingLevel,
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    preview: "",
    updatedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
  };
  const me = {
    userId: "user-fixture",
    name: "Fixture account",
    email: "fixture@example.test",
    spaceId: "space-fixture",
    isDeploymentOwner: false,
    needsModel: false,
    hasOnboarded: true,
    defaultProvider: null,
    defaultModel: null,
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "none",
    avatarStyle: "robot",
  };
  const thread = {
    threadId: "thread-fixture",
    botId: bot.id,
    cursor: 0,
    messages: [],
    olderCursor: null,
    run: null,
  };
  const groups = options.group
    ? [
        {
          id: "group-fixture",
          name: "Fixture group",
          members: [],
          threadId: "group-thread-fixture",
          unread: false,
          pinned: false,
          status: "idle",
          preview: "",
        },
      ]
    : [];
  await page.route("**/api/**", (route) => route.fulfill({ json: null }));
  await page.route("**/rpc/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(path);
    const reply = (json: unknown) => route.fulfill({ json: { json } });
    if (path === "/rpc/bootstrap")
      return reply({
        me,
        bots: [bot],
        groups,
        botSections: [],
        archivedBots: [],
        archivedGroups: [],
        spaces: [],
        thread,
        routines: [],
      });
    if (path === "/rpc/queue/list")
      return reply({
        version: 1,
        sessionId: "session-fixture",
        revision: 0,
        rows: [],
        identity: { nextIdNumber: 1, nextSequence: 1 },
        uncertainRowIds: [],
        paused: false,
        errorHold: false,
        modes: { steer: "all", followUp: "all" },
        gracefulPausePending: false,
      });
    if (path === "/rpc/me") return reply(me);
    if (path === "/rpc/bots/list") return reply([bot]);
    if (path === "/rpc/groups/list") return reply(groups);
    if (path === "/rpc/threads/get")
      return reply(
        options.group
          ? {
              ...thread,
              botId: undefined,
              groupId: "group-fixture",
              groupName: "Fixture group",
              members: [],
            }
          : thread,
      );
    if (path === "/rpc/models/runtime") {
      const input = route.request().postDataJSON().json;
      expect(input).toEqual({ botId: bot.id, ...(input.refresh ? { refresh: true } : {}) });
      if (options.delay)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (options.fail) return route.fulfill({ status: 503, body: "Offline failure" });
      return reply(runtime);
    }
    if (path === "/rpc/bots/update") {
      const input = route.request().postDataJSON().json;
      writes.push(input);
      if (options.fail) return route.fulfill({ status: 503, body: "Offline failure" });
      const requested = input.modelProvider
        ? {
            provider: input.modelProvider,
            modelId: input.modelId,
            thinkingLevel: input.thinkingLevel,
          }
        : null;
      runtime = {
        ...runtime,
        current: requested ?? runtime.profileDefault,
        selection: {
          requested,
          effective: requested ?? runtime.profileDefault,
          status: "applied",
          error: null,
        },
      };
      Object.assign(bot, {
        modelProvider: input.modelProvider,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel,
      });
      return reply(bot);
    }
    if (
      [
        "/rpc/bots/listArchived",
        "/rpc/groups/listArchived",
        "/rpc/botSections/list",
        "/rpc/spaces/list",
        "/rpc/routines/list",
        "/rpc/skills/list",
      ].includes(path)
    )
      return reply([]);
    return route.fulfill({ status: 503, body: "Offline fixture" });
  });
  await page.goto(`/e2e/fixtures/model-header.html${options.group ? "?group" : ""}`);
  return {
    writes,
    paths,
    options,
    release: () => release?.(),
    ready: () => Boolean(release),
    apply: () => {
      runtime = {
        ...runtime,
        current: next,
        selection: { requested: next, effective: next, status: "applied", error: null },
      };
    },
  };
}

for (const width of [1280, 375]) {
  test(`real bot header model control is left of computer (${width})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const fixture = await mount(page);
    await page.evaluate(
      (theme) => {
        document.documentElement.dataset.theme = theme;
      },
      width === 1280 ? "light" : "dark",
    );
    const trigger = page.getByTestId("bot-model-switcher");
    await expect(trigger).toBeVisible();
    const model = await trigger.boundingBox();
    const computer = await page.getByRole("button", { name: "Agent computer" }).boundingBox();
    expect(model!.x + model!.width).toBeLessThanOrEqual(computer!.x);
    expect(Math.abs(model!.y - computer!.y)).toBeLessThanOrEqual(1);
    expect(model!.height).toBe(30);
    await captureScreenshot(page, testInfo, `model-header-${width}`);
    await trigger.click();
    await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
    const input = await page.locator('[data-slot="command-input-wrapper"]').boundingBox();
    const first = await page.getByRole("listbox").getByRole("option").first().boundingBox();
    expect(first!.y - (input!.y + input!.height)).toBeGreaterThanOrEqual(12);
    await page.getByRole("combobox", { name: "Search models" }).fill("astra");
    await page.getByRole("listbox").getByRole("option").click();
    await expect
      .poll(() => fixture.writes)
      .toEqual([
        { botId: "bot-fixture", modelProvider: "fixture", modelId: "astra", thinkingLevel: null },
      ]);
    await page.getByRole("combobox", { name: "Thinking", exact: true }).selectOption("low");
    await expect
      .poll(() => fixture.writes)
      .toEqual([
        { botId: "bot-fixture", modelProvider: "fixture", modelId: "astra", thinkingLevel: null },
        { botId: "bot-fixture", modelProvider: "fixture", modelId: "astra", thinkingLevel: "low" },
      ]);
    await expect(trigger).toHaveText("Astra");
    await expect(page.getByTestId("current-model")).toHaveText("Current: fixture/astra · low");
    await captureScreenshot(page, testInfo, `model-header-pending-${width}`);
    fixture.apply();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByTestId("current-model")).toHaveText("Current: fixture/astra · low");
    await expect(trigger).toHaveText("Astra");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    expect(fixture.paths.some((path) => /setDefault|setWorkerSelection/.test(path))).toBe(false);
  });
}

test("first-run bot can choose desired model without claiming an effective model", async ({
  page,
}) => {
  const fixture = await mount(page, { firstRun: true, delay: true });
  await page.getByTestId("bot-model-switcher").click();
  await expect(page.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Use model", exact: true })).toHaveCount(0);
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(0);
  await expect.poll(fixture.ready).toBe(true);
  fixture.options.delay = false;
  fixture.release();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
  await expect(page.getByTestId("current-model")).toHaveText("Current: Unavailable");
  await page.getByRole("listbox").getByRole("option").nth(1).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  await expect(page.getByTestId("current-model")).toHaveText("Current: Unavailable");
});

test("header load and save failures are accessible and recoverable", async ({ page }) => {
  const fixture = await mount(page, { fail: true });
  await page.getByTestId("bot-model-switcher").click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Could not refresh models");
  await expect(page.getByRole("button", { name: "Use model", exact: true })).toHaveCount(0);
  fixture.options.fail = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Search models" }).fill("astra");
  fixture.options.fail = true;
  await page.getByRole("listbox").getByRole("option").click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Could not switch model");
  await expect(page.getByTestId("bot-model-switcher")).toHaveText("Sol");
  fixture.options.fail = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
});

test("a new bot shows its inherited model without an unsolicited pending label", async ({
  page,
}) => {
  const fixture = await mount(page, { firstRun: true, inherited: true });
  const trigger = page.getByTestId("bot-model-switcher");
  await trigger.click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
  await expect(trigger).toHaveText("Sol");
  expect(fixture.writes).toHaveLength(0);
});

test("group header never silently selects a bot", async ({ page }) => {
  await mount(page, { group: true });
  await expect(page.getByTestId("bot-settings-trigger")).toHaveText("Fixture group");
  await expect(page.getByTestId("bot-model-switcher")).toHaveCount(0);
});
