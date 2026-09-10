import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("shows peer chips in transcript and opens view-only peer chat", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `peer-msg-${stamp}@rakazo.test`, "password12", "Peer Msg");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  const researcher = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("message the bot named Researcher saying peer-exchange-alpha");
  await composer.press("Enter");
  await expect(page.getByText("messaging that bot now.").first()).toBeVisible({
    timeout: 60_000,
  });

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
        }>(page, "threads/messages", { botId: chiefId, includePeerRuns: true });
        const peerTexts = history.messages.flatMap((message) =>
          message.blocks
            .filter(
              (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
            )
            .map((block) => block.text ?? ""),
        );
        return peerTexts.some((text) => text.includes("peer-exchange-alpha"));
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
  await composer.fill("Keep this unsent draft");

  const transcript = page.getByTestId("transcript");
  const chip = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "Researcher" })
    .first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip.getByText(/messages? with/)).toBeVisible();
  await expect(chip).toHaveAccessibleName(/\d+ messages? with Researcher/);
  await expect(chip.locator(".rakazo-organic-avatar")).toBeVisible();
  await expect(chip).not.toContainText("{peer}");
  // User bubble still contains the phrase; peer body must not appear outside the chip.
  await expect(chip).not.toContainText("peer-exchange-alpha");
  await expect(transcript.getByText("peer-exchange-alpha")).toHaveCount(1);
  const assertChipLeftAligned = async () => {
    const transcriptBox = await transcript.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(transcriptBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    // Transcript padding is 16px mobile / 28px desktop; centering must fail this assertion.
    expect(chipBox!.x - transcriptBox!.x).toBeLessThanOrEqual(32);
    expect(chipBox!.width).toBeLessThan(transcriptBox!.width - 32);
  };

  await assertChipLeftAligned();
  await expect(composer).toBeVisible();
  await captureScreenshot(page, testInfo, "peer-chip-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await chip.scrollIntoViewIfNeeded();
  await expect(chip).toBeVisible();
  await expect(composer).toBeVisible();
  await assertChipLeftAligned();
  await captureScreenshot(page, testInfo, "peer-chip-mobile");

  const peerPageRequests: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/rpc/threads/messages") || request.method() !== "POST") return;
    const input = request.postDataJSON()?.json;
    if (input?.peerBotId) peerPageRequests.push(input);
  });
  await chip.focus();
  await expect(chip).toBeFocused();
  await chip.press("Enter");
  const view = page.getByTestId("peer-conversation-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("heading", { name: /Chief · Researcher/ })).toBeVisible();
  await expect(view.getByText("This chat is view-only")).toBeVisible();
  await expect(view.getByRole("button", { name: "Close" })).toHaveCount(1);
  await expect(view.getByText("peer-exchange-alpha").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await expect(view.getByText("Loading")).toHaveCount(0);
  expect(peerPageRequests).toHaveLength(1);
  expect(peerPageRequests[0]).toMatchObject({ botId: chiefId, peerBotId: expect.any(String) });
  expect(peerPageRequests[0]?.includePeerRuns).toBeUndefined();
  expect(peerPageRequests[0]?.before).toBeUndefined();
  const peerTranscript = view.getByTestId("peer-conversation-transcript");
  await peerTranscript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      peerTranscript.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
  await captureScreenshot(page, testInfo, "peer-view-only-mobile");
  await page.setViewportSize({ width: 1440, height: 900 });
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeInViewport();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(composer).toHaveCount(0);
  const coveredComposer = page.getByRole("combobox", {
    name: "Message Chief",
    includeHidden: true,
  });
  await expect(coveredComposer).toHaveCount(1);
  await expect(coveredComposer).toBeHidden();
  const [sidebarBox, viewBox] = await Promise.all([sidebar.boundingBox(), view.boundingBox()]);
  expect(sidebarBox).not.toBeNull();
  expect(viewBox).not.toBeNull();
  expect(viewBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width);
  const search = sidebar.getByPlaceholder("Search", { exact: true });
  await search.focus();
  await expect(search).toBeFocused();
  await captureScreenshot(page, testInfo, "peer-view-only-desktop");

  const close = view.getByRole("button", { name: "Close", exact: true });
  await close.focus();
  await close.press("Escape");
  await expect(view).toHaveCount(0);
  await expect(chip).toBeFocused();
  await chip.click();
  await expect(view).toBeVisible();
  await sidebar.getByRole("button", { name: /^Chief/ }).click();
  await expect(view).toHaveCount(0);
  await expect(composer).toBeVisible();
  await expect(composer).toHaveText("Keep this unsent draft");

  await chip.click();
  await expect(view).toBeVisible();
  await sidebar.getByRole("button", { name: /^Researcher/ }).click();
  await page.waitForURL(`**/app/${researcher.id}`);
  await expect(view).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Message Researcher" })).toBeVisible();

  await sidebar.getByRole("button", { name: /^Chief/ }).click();
  await chip.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await view.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(search).toBeInViewport();
  await captureScreenshot(page, testInfo, "peer-view-navigation-mobile");
  await sidebar.getByRole("button", { name: /^Researcher/ }).click();
  await expect(view).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Message Researcher" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Close navigation", exact: true })).toHaveCount(0);
});
