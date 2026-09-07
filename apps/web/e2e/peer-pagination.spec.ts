import { expect, test } from "@playwright/test";

test("peer pages skip interspersed normal messages with one request per explicit page", async ({
  page,
}) => {
  // Synthetic server history has more than one peer page amid ordinary chat.
  const history = Array.from({ length: 125 }, (_, index) => ({
    id: `message-${index + 1}`,
    threadId: "thread",
    botId: "bot",
    seq: index + 1,
    role: "system",
    createdAt: "2026-09-01T00:00:00Z",
    blocks:
      index % 2 === 0
        ? [
            {
              kind: "bot_message_sent",
              toBotId: "peer",
              toBotName: "Research",
              text: `Peer receipt ${index + 1}`,
            },
          ]
        : [{ kind: "text", text: `Ordinary text ${index + 1}` }],
  }));
  const requests: unknown[] = [];
  await page.route("**/rpc/threads/messages", (route) => {
    const input = route.request().postDataJSON().json;
    requests.push(input);
    const matching = history.filter(
      (message) =>
        message.blocks[0]?.kind === "bot_message_sent" &&
        (!input.before || message.seq < input.before),
    );
    const messages = matching.slice(-50);
    return route.fulfill({
      json: {
        json: {
          threadId: "thread",
          messages,
          olderCursor: matching.length > messages.length ? messages[0]!.seq : null,
        },
      },
    });
  });
  await page.goto("/e2e/fixtures/peer-visibility.html");
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Open peer", exact: true }).click();
  const view = page.getByTestId("peer-conversation-view");
  await expect(view.getByText("Peer receipt 125", { exact: true })).toBeVisible();
  expect(requests).toEqual([{ botId: "bot", peerBotId: "peer" }]);
  await expect(view.getByText(/Ordinary text/)).toHaveCount(0);
  await view.getByRole("button", { name: "Load earlier", exact: true }).click();
  await expect(view.getByText("Peer receipt 1", { exact: true })).toBeVisible();
  expect(requests).toEqual([
    { botId: "bot", peerBotId: "peer" },
    { botId: "bot", peerBotId: "peer", before: 27 },
  ]);
  await expect(view.getByRole("button", { name: "Load earlier", exact: true })).toHaveCount(0);
  await expect(view.getByRole("textbox")).toHaveCount(0);
});
