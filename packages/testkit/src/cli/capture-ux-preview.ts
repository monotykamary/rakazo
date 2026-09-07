import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";
import { expectAlignedControls } from "../playwright-layout.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const artifacts = path.join(root, ".artifacts");
const preview = JSON.parse(await readFile(path.join(artifacts, "preview.json"), "utf8")) as {
  origin: string;
  url: string;
  botId: string;
  email: string;
  password: string;
  fixture: boolean;
};
const origin = new URL(preview.origin);
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || preview.fixture !== true) {
  throw new Error("Capture requires the local synthetic UX preview");
}
if (new URL(preview.url).origin !== origin.origin) throw new Error("Preview URL origin mismatch");

const browser = await chromium.launch({ headless: true });
const failures: string[] = [];
let loadedFonts = 0;
const files: string[] = [];
let activePage: Page | undefined;
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await context.route("**/*", (route) => {
    const target = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(target.hostname) || target.protocol === "data:"
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  activePage = page;
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("response", (response) => {
    if (response.request().resourceType() !== "font") return;
    if (response.ok()) loadedFonts++;
    else failures.push(`Preview font request failed (${response.status()})`);
  });
  await page.goto(`${origin.origin}/sign-in`);
  await page.getByPlaceholder("Your email address").fill(preview.email);
  await page.getByPlaceholder("Password", { exact: true }).fill(preview.password);
  await page.getByRole("button", { name: "Continue with email", exact: true }).click();
  await page.waitForURL("**/app/**");
  await page.goto(preview.url);
  await page.getByTestId("transcript").waitFor();
  await page.evaluate(() => document.fonts.ready);
  expect(loadedFonts).toBeGreaterThan(0);
  const capture = async (name: string) => {
    await page.screenshot({
      path: path.join(artifacts, `${name}.png`),
      fullPage: true,
      animations: "disabled",
      caret: "hide",
    });
    files.push(`${name}.png`);
  };
  await capture("01-coordinator-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await capture("02-coordinator-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("03-coordinator-mobile-web");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light" });
  const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
    const response = await page.request.post(`${origin.origin}/rpc/${procedure}`, {
      headers: { origin: origin.origin },
      data: { json: input },
    });
    if (!response.ok()) throw new Error(`Preview ${procedure} failed (${response.status()})`);
    return ((await response.json()) as { json: T }).json;
  };
  const bots = await rpc<Array<{ id: string; name: string }>>("bots/list", {});
  if (!bots.some((bot) => bot.name === "Researcher")) {
    await rpc("bots/create", {
      name: "Researcher",
      title: "Research",
      description: "",
      instructions: "Find reliable sources. Return the useful facts and links.",
      notifyOnFinish: true,
    });
  }
  const routines = await rpc<Array<{ id: string; name: string; prompt: string }>>("routines/list", {
    botId: preview.botId,
  });
  const routine =
    routines.find((item) => item.name === "Morning review") ??
    (await rpc<{ id: string; prompt: string }>("routines/create", {
      botId: preview.botId,
      name: "Morning review",
      prompt: "Review the project notes.",
      crons: ["0 9 * * 1-5"],
      timezone: "UTC",
      active: false,
      notify: true,
    }));
  if (routine.prompt !== "Review Atlas and report anything blocked.") {
    await rpc("routines/update", {
      routineId: routine.id,
      prompt: "Review Atlas and report anything blocked.",
    });
  }
  await page.reload();
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await expect(composer).toBeVisible();
  const peerChip = page.getByTestId("peer-receipt-chip").filter({ hasText: "Researcher" }).first();
  if ((await peerChip.count()) === 0) {
    await composer.fill("message the bot named Researcher saying Review the Atlas release notes");
    await composer.press("Enter");
  }
  await expect(peerChip).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await capture("04-contextual-activity");
  await peerChip.click();
  const peerView = page.getByTestId("peer-conversation-view");
  await expect(peerView).toBeVisible();
  await expect(
    peerView.getByText("Review the Atlas release notes", { exact: true }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(peerView).toContainText("The Atlas review is ready.", { timeout: 30_000 });
  await expect(peerView).not.toContainText("[bot]");
  await expect(peerView.getByRole("textbox")).toHaveCount(0);
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeInViewport();
  const [sidebarBox, peerBox] = await Promise.all([sidebar.boundingBox(), peerView.boundingBox()]);
  expect(peerBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const coveredComposer = page.getByRole("combobox", {
    name: "Message Chief",
    includeHidden: true,
  });
  await expect(coveredComposer).toHaveCount(1);
  await expect(coveredComposer).toBeHidden();
  await capture("05-peer-conversation");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("06-peer-conversation-mobile-web");
  await peerView.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(sidebar.getByPlaceholder("Search", { exact: true })).toBeInViewport();
  await capture("06b-peer-navigation-mobile-web");
  await page.getByRole("button", { name: "Close navigation", exact: true }).click();
  await peerView.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Updated routine Morning review", exact: true })
    .last()
    .click();
  await expect(page.locator("label:has-text('Name') input")).toHaveValue("Morning review");
  await expect(page.locator("label:has-text('Instruction') textarea")).toHaveValue(
    "Review Atlas and report anything blocked.",
  );
  await capture("07-routine-sidebar");
  await page.goto(preview.url);
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByRole("menuitem", { name: "Execution", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Execution", exact: true });
  await expect(inspector).toBeVisible();
  const runSelect = inspector.getByRole("combobox", { name: "Run", exact: true });
  const flowButton = inspector.getByRole("button", { name: "Flow", exact: true });
  await expectAlignedControls(runSelect, flowButton);
  await capture("08-execution-inspector");
  await flowButton.click();
  const outline = inspector.getByTestId("execution-flow");
  await expect(outline.getByText("Chief", { exact: true })).toBeVisible();
  await expect(outline.getByText("Researcher", { exact: true })).toBeVisible();
  await expect(outline).not.toContainText("run:");
  await expect(outline).not.toContainText("message:");
  const assertFlowFits = async () => {
    await expectAlignedControls(runSelect, flowButton);
    await expect
      .poll(() =>
        outline.evaluate((element) =>
          Array.from(element.querySelectorAll("*")).every(
            (item) => item.scrollWidth <= item.clientWidth + 1,
          ),
        ),
      )
      .toBe(true);
  };
  await assertFlowFits();
  await capture("09-execution-flow");
  await page.emulateMedia({ colorScheme: "dark" });
  await assertFlowFits();
  await capture("09b-execution-flow-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await assertFlowFits();
  await capture("09c-execution-flow-mobile-web");
  await context.storageState({ path: path.join(artifacts, "preview-auth.json") });
  if (failures.length) throw new Error(`Browser errors: ${failures.join("; ")}`);
  await writeFile(
    path.join(artifacts, "screenshots.json"),
    `${JSON.stringify({ fixture: true, files }, null, 2)}\n`,
  );
  console.log(`Captured ${files.length} local preview screens in .artifacts/`);
} catch (error) {
  if (activePage) {
    await activePage.screenshot({
      path: path.join(artifacts, "capture-failed.png"),
      fullPage: true,
    });
    await writeFile(
      path.join(artifacts, "capture-failed.json"),
      JSON.stringify(
        {
          url: activePage.url(),
          errors: failures,
          body: await activePage.locator("body").innerText(),
        },
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await browser.close();
}
