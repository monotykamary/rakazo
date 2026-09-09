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
