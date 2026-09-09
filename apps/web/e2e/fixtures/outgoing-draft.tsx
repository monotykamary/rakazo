import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ThreadSnapshot } from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactTarget } from "../../src/lib/artifact-open";
import { dictation } from "../../src/lib/dictation";
import { rpc } from "../../src/lib/rpc";
import { CallView } from "../../src/pages/CallView";
import { Transcript } from "../../src/pages/Shell";
import "../../src/styles.css";

const noop = () => {};
const asyncNoop = async () => {};
const params = new URLSearchParams(location.search);
const target: ArtifactTarget = params.has("group") ? { groupId: "group" } : { botId: "bot" };
let microphoneStarts = 0;
dictation.listen = async () => {
  microphoneStarts += 1;
};
Object.assign(window, { microphoneStarts: () => microphoneStarts });

function Fixture() {
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [call, setCall] = useState(params.has("call"));
  const scrollRef = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    setSnapshot(await rpc.threads.get(target));
  }, []);
  useEffect(() => {
    void refresh();
    Object.assign(window, { refreshDraft: refresh });
  }, [refresh]);
  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col bg-background text-foreground">
      <Transcript
        loading={false}
        scrollRef={scrollRef}
        artifactTarget={target}
        messages={snapshot?.messages ?? []}
        olderCursor={null}
        loadingOlder={false}
        answerableAskMessageId={
          new URLSearchParams(location.search).has("readonly") ? null : "draft-message"
        }
        running={false}
        workingBots={[]}
        onLoadOlder={asyncNoop}
        onOpenBot={noop}
        onAnswer={async () => {
          throw new Error("Draft must not use generic AskCard");
        }}
        onReply={noop}
        onReact={asyncNoop}
        onJumpToMessage={noop}
        onOpenPeerMessages={noop}
        onOpenExecution={noop}
        onOpenRoutine={asyncNoop}
        peerBot={() => undefined}
        onRefresh={refresh}
        onBotChanged={asyncNoop}
        onAddRoutine={noop}
        voiceReady={false}
        speakingMessageId={null}
        onSpeak={noop}
      />
      {call && snapshot ? (
        <CallView
          botId="bot"
          botName="Fixture Bot"
          transcribe={false}
          snapshot={snapshot}
          onSend={asyncNoop}
          onFollowUp={asyncNoop}
          onAnswer={async () => {
            throw new Error("Draft must not use a spoken answer");
          }}
          onClose={() => setCall(false)}
        />
      ) : null}
    </main>
  );
}

i18n.load("en", {});
i18n.activate("en");
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <Fixture />
  </I18nProvider>,
);
