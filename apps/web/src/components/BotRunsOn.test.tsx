import type { Bot } from "@rakazo/contracts";
import { BOT_OFFICE_PROMPTS } from "@rakazo/core";
import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  machineId: null as string | null,
  assign: vi.fn(),
  setOpen: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { machines: { assign: state.assign } } }));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => undefined,
  useState: (initial: unknown) => [initial, state.setOpen],
  useSyncExternalStore: () => ({
    phase: "ready",
    botMachineId: state.machineId,
    machines: [],
    pairing: null,
    error: null,
  }),
}));

import { BotRunsOn } from "./BotRunsOn";

type Props = {
  children?: ReactNode;
  "data-testid"?: string;
  onClick?: () => void;
  disabled?: boolean;
  "aria-label"?: string;
};
function trigger(node: ReactNode, label?: string): Props | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Props>(child)) continue;
    if (
      label ? child.props["aria-label"] === label : child.props["data-testid"] === "runs-on-trigger"
    )
      return child.props;
    const found = trigger(child.props.children, label);
    if (found) return found;
  }
}

describe("Office actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", { location: { origin: "https://example.test" } });
  });
  it.each([null, "office-1"])(
    "click sends the bot prompt, never an assignment (%s)",
    async (machineId) => {
      state.machineId = machineId;
      const onPrompt = vi.fn(async () => undefined);
      const button = trigger(BotRunsOn({ bot: { id: "settings-bot" } as Bot, onPrompt }));
      expect(button?.disabled).toBe(false);
      button?.onClick?.();
      expect(onPrompt).toHaveBeenCalledExactlyOnceWith(
        "settings-bot",
        machineId ? BOT_OFFICE_PROMPTS.move : BOT_OFFICE_PROMPTS.link,
      );
      expect(state.assign).not.toHaveBeenCalled();
    },
  );
  it("opens administration with no offices without sending or assigning", () => {
    state.machineId = null;
    const onPrompt = vi.fn();
    const button = trigger(BotRunsOn({ bot: { id: "bot" } as Bot, onPrompt }), "Manage offices");
    expect(button).toBeDefined();
    button!.onClick!();
    expect(state.setOpen).toHaveBeenCalledWith(true);
    expect(onPrompt).not.toHaveBeenCalled();
    expect(state.assign).not.toHaveBeenCalled();
  });
  it("disables prompts during a send", () => {
    expect(
      trigger(BotRunsOn({ bot: { id: "bot" } as Bot, onPrompt: vi.fn(), disabled: true }))
        ?.disabled,
    ).toBe(true);
  });
});
