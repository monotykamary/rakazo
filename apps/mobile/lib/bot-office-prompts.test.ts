import { BOT_OFFICE_PROMPTS, type BotPromptHandler } from "@rakazo/core";
import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  machineId: null as string | null,
  hook: 0,
  rpc: vi.fn(),
  dismissTo: vi.fn(),
  setError: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: () => undefined,
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [
    state.hook++ === 0 ? { id: "settings-bot", name: "Bot" } : initial,
    state.setError,
  ],
  useSyncExternalStore: () => ({
    phase: "ready",
    botMachineId: state.machineId,
    machines: [],
    pairing: null,
    error: null,
  }),
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  Modal: "Modal",
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("expo-router", () => ({
  Stack: { Screen: "Screen" },
  useLocalSearchParams: () => ({ botId: "another-route-bot" }),
  useRouter: () => ({ dismissTo: state.dismissTo }),
}));
vi.mock("./api", () => ({ rpc: state.rpc, currentApiBase: () => "https://example.test" }));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: "BotAvatar" }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: "NativeSymbol" }));
vi.mock("../components/ModelSelectionControl", () => ({
  ModelSelectionControl: "ModelSelectionControl",
}));

import BotSettingsScreen from "../app/bot-settings";
import { RunsOnPicker } from "../components/runs-on-picker";

type Props = {
  children?: ReactNode;
  onPrompt?: BotPromptHandler;
  accessibilityLabel?: string;
  onPress?: () => void;
};
function find(node: ReactNode, match: (props: Props) => boolean): Props | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Props>(child)) continue;
    if (match(child.props)) return child.props;
    const found = find(child.props.children, match);
    if (found) return found;
  }
}
function parentPrompt() {
  return find(BotSettingsScreen(), (props) => !!props.onPrompt)!.onPrompt!;
}

describe("mobile Office prompt wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.hook = 0;
    state.rpc.mockResolvedValue({});
  });
  it.each([null, "office-1"])(
    "click durably sends to the settings bot and opens its conversation (%s)",
    async (machineId) => {
      state.machineId = machineId;
      const onPrompt = parentPrompt();
      let sent: Promise<void> | undefined;
      const tree = RunsOnPicker({
        botId: "settings-bot",
        apiBase: "https://example.test",
        onPrompt: (botId, text) => (sent = onPrompt(botId, text)),
      });
      find(
        tree,
        (props) => props.accessibilityLabel === (machineId ? "Move office" : "Link office"),
      )!.onPress!();
      await sent;
      expect(state.rpc).toHaveBeenCalledExactlyOnceWith("threads/send", {
        botId: "settings-bot",
        text: machineId ? BOT_OFFICE_PROMPTS.move : BOT_OFFICE_PROMPTS.link,
        clientNonce: expect.any(String),
      });
      expect(state.dismissTo).toHaveBeenCalledExactlyOnceWith({
        pathname: "/thread",
        params: { botId: "settings-bot", name: "Bot" },
      });
    },
  );
  it("opens administration with no offices without sending or assigning", () => {
    state.machineId = null;
    state.hook = 1;
    const onPrompt = vi.fn();
    const button = find(
      RunsOnPicker({ botId: "settings-bot", apiBase: "https://example.test", onPrompt }),
      (props) => props.accessibilityLabel === "Manage offices",
    );
    expect(button).toBeDefined();
    button!.onPress!();
    expect(state.setError).toHaveBeenCalledWith(true);
    expect(onPrompt).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("keeps settings open on failure and permits retry", async () => {
    state.rpc.mockRejectedValueOnce(new Error("Offline"));
    const onPrompt = parentPrompt();
    await onPrompt("settings-bot", BOT_OFFICE_PROMPTS.link);
    expect(state.dismissTo).not.toHaveBeenCalled();
    expect(state.setError).toHaveBeenCalledWith("Offline");
    await onPrompt("settings-bot", BOT_OFFICE_PROMPTS.link);
    expect(state.dismissTo).toHaveBeenCalledOnce();
  });
  it("ignores duplicate presses while the durable send is pending", async () => {
    let finish!: () => void;
    state.rpc.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const onPrompt = parentPrompt();
    const pending = onPrompt("settings-bot", BOT_OFFICE_PROMPTS.link);
    await onPrompt("settings-bot", BOT_OFFICE_PROMPTS.link);
    expect(state.rpc).toHaveBeenCalledOnce();
    expect(state.dismissTo).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(state.dismissTo).toHaveBeenCalledOnce();
  });
});
