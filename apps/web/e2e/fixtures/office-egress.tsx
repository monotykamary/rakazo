import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { BOT_COLORS } from "@rakazo/contracts";
import { X } from "lucide-react";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { BotSettings } from "../../src/pages/shell/bot-panel.tsx";
import "../../src/styles.css";

i18n.load("en", {});
i18n.activate("en");

const now = new Date().toISOString();
const bot = {
  id: "bot-fixture",
  spaceId: "space-fixture",
  name: "New Bot",
  title: "",
  description: "",
  instructions: "",
  color: BOT_COLORS[0],
  notifyOnFinish: false,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "thread-fixture",
  preview: "",
  status: "idle",
  computerMode: "shared",
  updatedAt: now,
  createdAt: now,
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
};
const machine = {
  id: "machine-studio",
  name: "Studio",
  status: "online",
  version: "0.1.2",
  lastSeenAt: now,
  createdAt: now,
};
const egress = {
  enabled: true,
  hostConnected: true,
  activeConnections: 2,
  sessionTotal: 2,
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof Request
        ? input.url
        : String(input);
  const json = (body: unknown) =>
    new Response(JSON.stringify({ json: body }), {
      headers: { "content-type": "application/json" },
    });
  if (url.includes("/rpc/machines/list")) return json([machine]);
  if (url.includes("/rpc/machines/assignment")) {
    return json({ botId: bot.id, machineId: machine.id, computerId: null });
  }
  if (url.includes("/rpc/machines/egress/")) return json(egress);
  if (url.includes("/rpc/models/runtime")) {
    return json({
      catalog: [],
      current: null,
      selection: null,
      profileDefault: null,
      availability: { status: "available", error: null },
    });
  }
  if (url.includes("/rpc/voice/")) return json([]);
  if (url.includes("/rpc/services/")) return json({ services: [] });
  if (url.includes("/rpc/")) return json(null);
  return originalFetch(input, init);
};

window.rakazoDesktop = {
  platform: "darwin",
  window: {
    close: async () => undefined,
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
  },
  update: {
    state: async () => ({
      phase: "unsupported",
      currentVersion: "0.1.0",
      availableVersion: null,
      percent: null,
      message: null,
      checkedAt: null,
    }),
    check: async () => ({
      phase: "unsupported",
      currentVersion: "0.1.0",
      availableVersion: null,
      percent: null,
      message: null,
      checkedAt: null,
    }),
    download: async () => ({
      phase: "unsupported",
      currentVersion: "0.1.0",
      availableVersion: null,
      percent: null,
      message: null,
      checkedAt: null,
    }),
    install: async () => ({
      phase: "unsupported",
      currentVersion: "0.1.0",
      availableVersion: null,
      percent: null,
      message: null,
      checkedAt: null,
    }),
  },
  egress: {
    start: async () => undefined,
    stop: async () => undefined,
    state: async () => ({
      connected: true,
      activeConnections: 2,
      sessionTotal: 2,
    }),
    onChange: (listener) => {
      listener({ connected: true, activeConnections: 2, sessionTotal: 2 });
      return () => undefined;
    },
  },
  oauth: { onCallback: () => () => undefined },
};

function Fixture() {
  return h(
    "div",
    {
      className: "flex h-screen min-h-0 overflow-hidden bg-background text-foreground",
      "data-testid": "shell-root",
    },
    h(
      "aside",
      {
        className:
          "flex h-full w-[316px] shrink-0 flex-col border-e border-sidebar-border bg-sidebar",
      },
      h("div", { className: "px-[18px] pb-3 pt-4 text-[15px] text-foreground/80" }, "Rakazo"),
      h(
        "div",
        { className: "px-3 py-1" },
        h(
          "div",
          {
            className:
              "flex items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-[14px]",
          },
          h("span", {
            className: "size-2 shrink-0 rounded-full",
            style: { backgroundColor: bot.color },
          }),
          h("span", { className: "truncate" }, bot.name),
        ),
      ),
    ),
    h(
      "main",
      { className: "flex min-w-0 flex-1 flex-col" },
      h(
        "header",
        {
          className:
            "flex h-12 shrink-0 items-center border-b border-border px-4 text-[15px]",
        },
        bot.name,
      ),
      h("div", {
        className: "min-h-0 flex-1",
        "data-testid": "transcript",
      }),
      h(
        "div",
        { className: "border-t border-border px-4 py-3" },
        h("div", {
          className:
            "rounded-md border border-border px-3 py-2 text-[14px] text-muted-foreground",
        }, `Message ${bot.name}`),
      ),
    ),
    h(
      "aside",
      {
        className:
          "flex h-full w-[384px] shrink-0 flex-col overflow-hidden border-s border-sidebar-border bg-background",
        "data-testid": "side-panel",
        "data-panel": "settings",
      },
      h(
        "div",
        { className: "rk-scroll h-full overflow-y-auto px-5 py-[17px]" },
        h(
          "div",
          { className: "mb-4 flex items-center justify-between" },
          h("span", { className: "text-[13.5px] text-muted-foreground" }, "Settings"),
          h(
            "button",
            {
              type: "button",
              className: "text-muted-foreground",
              "aria-label": "Close",
            },
            h(X, { size: 16 }),
          ),
        ),
        h(BotSettings, {
          bot,
          memoryProviderConfigured: false,
          onSkillsChange: () => undefined,
          onSave: async () => undefined,
          onExport: async () => undefined,
          onClear: () => undefined,
          onPrompt: async () => undefined,
        }),
      ),
    ),
  );
}

createRoot(document.getElementById("root")!).render(
  h(I18nProvider, { i18n }, h(BrowserRouter, {}, h(Fixture))),
);
