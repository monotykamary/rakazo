import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ThreadMessage } from "@rakazo/contracts";
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { Transcript } from "../../src/pages/Shell";
import "../../src/styles.css";

i18n.load("en", {});
i18n.activate("en");
const botColor = "hsl(190 30% 45%)";

const noop = () => {};
const asyncNoop = async () => {};
const createdAt = "2026-01-01T00:00:00Z";

function botMessage(id: string, seq: number, blocks: ThreadMessage["blocks"]): ThreadMessage {
  return {
    id,
    threadId: "thread",
    seq,
    role: "bot",
    botId: "bot",
    runId: "run",
    createdAt,
    blocks,
  };
}

const messages: ThreadMessage[] = [
  {
    id: "user-1",
    threadId: "thread",
    seq: 1,
    role: "user",
    createdAt,
    blocks: [{ kind: "text", text: "Check my inbox and draft a note to Sarah." }],
  },
  botMessage("steps-1", 2, [
    {
      kind: "steps",
      steps: [
        { label: "Sign in", count: 2 },
        { label: "Open Gmail", count: 1 },
      ],
    },
  ]),
  botMessage("takeover-1", 3, [
    {
      kind: "computer",
      state: "Needs you",
      text: "Please sign in to Gmail on the shared browser, then hand it back.",
    },
  ]),
  botMessage("steps-2", 4, [
    {
      kind: "steps",
      steps: [
        { label: "Sign in", count: 2 },
        { label: "Check email", count: 1 },
      ],
    },
  ]),
  botMessage("ask-1", 5, [
    {
      kind: "ask",
      text: "Finished checking email, but Gmail is still signed out. Sign in on the shared browser, then this can be re-run.",
      status: "pending",
    },
  ]),
  botMessage("draft-1", 6, [
    {
      kind: "ask",
      text: "Generic approval must not render",
      approvalEffectId: "effect",
      status: "pending",
      draft: {
        kind: "outgoing_message",
        revision: 1,
        hash: "a".repeat(64),
        status: "pending",
        channel: "email",
        canApprove: true,
        ownerUserId: "owner",
        account: { connector: "email", label: "cory@acme.test" },
        fields: {
          to: ["sarah@acme.test"],
          subject: "Moving Friday’s design review to 2 PM",
          body: "Hi Sarah,\n\nCould we move Friday’s design review from 11 AM to 2 PM?\n\nThanks,\nCory",
        },
        editable: ["to", "cc", "bcc", "subject", "body"],
      },
    },
  ]),
];

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col bg-background text-foreground">
      <Transcript
        loading={false}
        scrollRef={scrollRef}
        artifactTarget={{ botId: "bot" }}
        messages={messages}
        olderCursor={null}
        loadingOlder={false}
        answerableAskMessageId="ask-1"
        running={false}
        workingBots={[{ botId: "bot", name: "Atlas", color: botColor }]}
        onLoadOlder={asyncNoop}
        onOpenBot={noop}
        onAnswer={asyncNoop}
        onReply={noop}
        onReact={asyncNoop}
        onJumpToMessage={noop}
        onOpenPeerMessages={noop}
        onOpenComputer={noop}
        onOpenExecution={noop}
        onOpenRoutine={asyncNoop}
        peerBot={() => ({ color: botColor })}
        onRefresh={asyncNoop}
        onBotChanged={asyncNoop}
        onAddRoutine={noop}
        voiceReady={false}
        speakingMessageId={null}
        onSpeak={noop}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <Fixture />
  </I18nProvider>,
);
