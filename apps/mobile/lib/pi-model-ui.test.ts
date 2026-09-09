import type { ModelSelection } from "@rakazo/contracts";
import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  modelIdentity,
  modelKey,
  type PiModelSnapshot,
  retainPiInventory,
  searchPiModels,
} from "./pi-models";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  effects: [] as (() => undefined | (() => void))[],
  deps: [] as (unknown[] | undefined)[],
  cleanups: [] as (() => void)[],
  rpc: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (next: unknown) => {
        hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
      },
    ];
  },
  useCallback: (callback: unknown, deps: unknown[]) => {
    const index = hooks.cursor++;
    if (!hooks.deps[index] || !deps.every((value, i) => Object.is(value, hooks.deps[index]![i]))) {
      hooks.deps[index] = deps;
      hooks.values[index] = callback;
    }
    return hooks.values[index];
  },
  useEffect: (effect: () => undefined | (() => void), deps: unknown[]) => {
    const index = hooks.cursor++;
    if (hooks.deps[index] && deps.every((value, i) => Object.is(value, hooks.deps[index]![i])))
      return;
    hooks.deps[index] = deps;
    hooks.effects.push(() => {
      hooks.cleanups[index]?.();
      const cleanup = effect();
      if (cleanup) hooks.cleanups[index] = cleanup;
    });
  },
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    const index = hooks.cursor++;
    if (hooks.deps[index]?.[0] !== effect) {
      hooks.deps[index] = [effect];
      hooks.effects.push(() => {
        hooks.cleanups[index]?.();
        const cleanup = effect();
        if (cleanup) hooks.cleanups[index] = cleanup;
      });
    }
  },
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  FlatList: "FlatList",
  Modal: "Modal",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  ActivityIndicator: "ActivityIndicator",
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("./api", () => ({ rpc: hooks.rpc }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

import Models from "../app/models";
import { ModelSelectionControl } from "../components/ModelSelectionControl";

type Props = {
  children?: ReactNode;
  onPress?: () => void | Promise<void>;
  onChangeText?: (value: string) => void;
  disabled?: boolean;
  visible?: boolean;
  accessibilityState?: { checked?: boolean };
  accessibilityLabel?: string;
  data?: { key: string; label: string }[];
  renderItem?: (value: { item: { key: string; label: string } }) => ReactNode;
};
function nodes(tree: ReactNode): Props[] {
  return Children.toArray(tree).flatMap((child) =>
    isValidElement<Props>(child) ? [child.props, ...nodes(child.props.children)] : [],
  );
}
function text(tree: ReactNode): string {
  return Children.toArray(tree)
    .map((child) => (isValidElement<Props>(child) ? text(child.props.children) : String(child)))
    .join("");
}
function button(tree: ReactNode, label: string) {
  return nodes(tree).find((node) => node.onPress && text(node.children) === label)!;
}
function render(factory: () => ReactNode) {
  hooks.cursor = 0;
  const tree = factory();
  for (const effect of hooks.effects.splice(0)) effect();
  return tree;
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
const current: ModelSelection = {
  provider: "pi-provider",
  modelId: "current-id",
  thinkingLevel: "low",
};
const requested: ModelSelection = {
  provider: "other-provider",
  modelId: "real-id",
  thinkingLevel: null,
};
function snapshot(): PiModelSnapshot {
  return {
    catalog: [
      {
        provider: requested.provider,
        id: requested.modelId,
        label: "Display name",
        billing: "",
        thinkingLevels: ["off", "low"],
      },
    ],
    profileDefault: { ...current, modelId: "profile-id" },
    current,
    selection: { requested, effective: current, status: "pending", error: null },
    availability: { status: "available", error: null },
  };
}
beforeEach(() => {
  for (const cleanup of hooks.cleanups) cleanup?.();
  hooks.cursor = 0;
  hooks.values = [];
  hooks.effects = [];
  hooks.deps = [];
  hooks.cleanups = [];
  hooks.rpc.mockReset();
  hooks.rpc.mockResolvedValue(snapshot());
});
async function openControl(
  worker?: { threadId: string; participantId?: string },
  initial: ModelSelection | null = requested,
) {
  const factory = () => ModelSelectionControl({ botId: "bot", worker, initial });
  button(render(factory), `Model${initial ? ` · ${initial.modelId}` : ""}`).onPress!();
  render(factory);
  await flush();
  render(factory);
  await flush();
  return { factory, tree: render(factory) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("native Pi model UI", () => {
  it("opens the compact current-model label and saves only the explicit bot worker", async () => {
    const factory = () =>
      ModelSelectionControl({ botId: "bot", worker: { threadId: "thread" }, compact: true });
    render(factory);
    await flush();
    render(factory);
    await flush();
    const tree = render(factory);
    expect(nodes(tree).find((node) => node.visible !== undefined)?.visible).toBe(false);
    button(tree, "current-id").onPress!();
    render(factory);
    await flush();
    render(factory);
    await flush();
    hooks.rpc.mockResolvedValueOnce({ ...snapshot().selection!, status: "applied" });
    button(render(factory), "Save").onPress!();
    await flush();
    expect(hooks.rpc).toHaveBeenCalledWith("models/setWorkerSelection", {
      botId: "bot",
      threadId: "thread",
      selection: requested,
    });
    expect(
      hooks.rpc.mock.calls.every(
        ([route, input]) =>
          (route === "models/runtime" || route === "models/setWorkerSelection") &&
          input.botId === "bot" &&
          input.threadId === "thread",
      ),
    ).toBe(true);
  });
  it("an old save cannot clear a new scope's busy state", async () => {
    let participantId = "first";
    const factory = () =>
      ModelSelectionControl({ botId: "bot", worker: { threadId: "thread", participantId } });
    button(render(factory), "Model").onPress!();
    render(factory);
    await flush();
    render(factory);
    await flush();
    const oldSave = deferred<unknown>();
    hooks.rpc.mockReturnValueOnce(oldSave.promise);
    button(render(factory), "Save").onPress!();
    participantId = "second";
    render(factory);
    await flush();
    render(factory);
    await flush();
    const newSave = deferred<unknown>();
    hooks.rpc.mockReturnValueOnce(newSave.promise);
    button(render(factory), "Save").onPress!();
    oldSave.resolve(snapshot().selection);
    await flush();
    expect(button(render(factory), "Save").disabled).toBe(true);
    newSave.reject(new Error("retry"));
    await flush();
    expect(button(render(factory), "Save").disabled).toBe(false);
  });
  it("uses shared identity encoding", () => {
    expect(modelKey("provider", "model::id")).toBe("provider::model::id");
  });
  it("keeps an edited draft through a delayed refresh", async () => {
    const { factory, tree } = await openControl({ threadId: "thread" });
    const load = deferred<PiModelSnapshot>();
    hooks.rpc.mockReturnValueOnce(load.promise);
    button(tree, "Refresh").onPress!();
    render(factory);
    button(render(factory), "low").onPress!();
    const next = snapshot();
    next.selection!.requested = { ...requested, thinkingLevel: "off" };
    load.resolve(next);
    await flush();
    expect(button(render(factory), "low").accessibilityState?.checked).toBe(true);
    button(render(factory), "Save").onPress!();
    expect(hooks.rpc).toHaveBeenLastCalledWith("models/setWorkerSelection", {
      botId: "bot",
      threadId: "thread",
      selection: { ...requested, thinkingLevel: "low" },
    });
    await flush();
  });
  it("invalidates an in-flight poll and suppresses polling during save", async () => {
    vi.useFakeTimers();
    try {
      const { factory } = await openControl({ threadId: "thread" });
      const load = deferred<PiModelSnapshot>();
      const save = deferred<NonNullable<PiModelSnapshot["selection"]>>();
      hooks.rpc.mockReturnValueOnce(load.promise).mockReturnValueOnce(save.promise);
      vi.advanceTimersByTime(2000);
      button(render(factory), "Save").onPress!();
      const count = hooks.rpc.mock.calls.length;
      vi.advanceTimersByTime(4000);
      expect(hooks.rpc).toHaveBeenCalledTimes(count);
      load.resolve({ ...snapshot(), availability: { status: "unavailable", error: "stale poll" } });
      await flush();
      expect(text(render(factory))).not.toContain("stale poll");
      save.resolve({ ...snapshot().selection!, status: "applied" });
      await flush();
      expect(text(render(factory))).toContain("Applied");
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(
    ["scope", "close", "unmount"].flatMap((transition) =>
      [false, true].flatMap((worker) =>
        [false, true].map((reject) => ({ transition, worker, reject })),
      ),
    ),
  )("ignores stale save responses: %j", async ({ transition, worker, reject }) => {
    let botId = "bot";
    const onSaved = vi.fn();
    const factory = () =>
      ModelSelectionControl({
        botId,
        worker: worker ? { threadId: "thread" } : undefined,
        initial: requested,
        onSaved,
      });
    button(render(factory), "Model · real-id").onPress!();
    render(factory);
    await flush();
    render(factory);
    await flush();
    const save = deferred<unknown>();
    hooks.rpc.mockReturnValueOnce(save.promise);
    button(render(factory), "Save").onPress!();
    if (transition === "scope") {
      botId = "new-bot";
      render(factory);
      await flush();
    }
    if (transition === "close") {
      button(render(factory), "Close").onPress!();
      render(factory);
    }
    if (transition === "unmount") for (const cleanup of hooks.cleanups) cleanup?.();
    const before = [...hooks.values];
    if (reject) save.reject(new Error("stale save"));
    else save.resolve(snapshot().selection);
    await flush();
    expect(onSaved).not.toHaveBeenCalled();
    expect(hooks.values).toEqual(before);
    if (transition === "scope") {
      const tree = render(factory);
      expect(nodes(tree).find((node) => node.visible !== undefined)?.visible).toBe(true);
      expect(button(tree, "Save").disabled).toBe(false);
    }
  });
  it.each(
    ["scope", "close", "unmount"].flatMap((transition) =>
      [false, true].map((reject) => ({ transition, reject })),
    ),
  )("ignores delayed load: %j", async ({ transition, reject }) => {
    let botId = "bot";
    const factory = () => ModelSelectionControl({ botId, initial: requested });
    const load = deferred<PiModelSnapshot>();
    hooks.rpc.mockReturnValueOnce(load.promise);
    button(render(factory), "Model · real-id").onPress!();
    render(factory);
    if (transition === "scope") {
      botId = "new-bot";
      render(factory);
      await flush();
    }
    if (transition === "close") {
      button(render(factory), "Close").onPress!();
      render(factory);
    }
    if (transition === "unmount") for (const cleanup of hooks.cleanups) cleanup?.();
    const before = [...hooks.values];
    if (reject) load.reject(new Error("stale load"));
    else
      load.resolve({ ...snapshot(), availability: { status: "unavailable", error: "stale load" } });
    await flush();
    expect(hooks.values).toEqual(before);
  });
  it("global refresh failure retains inventory and profile default without allowing writes", async () => {
    render(Models);
    await flush();
    let tree = render(Models);
    hooks.rpc.mockRejectedValue(new Error("Offline"));
    button(tree, "Refresh").onPress!();
    render(Models);
    await flush();
    tree = render(Models);
    expect(hooks.rpc).toHaveBeenLastCalledWith("models/runtime", { refresh: true });
    expect(text(tree)).toContain("Offline");
    expect(text(tree)).toContain("profile-id");
    expect(nodes(tree).find((node) => node.data)!.data).toHaveLength(1);
    expect(hooks.rpc.mock.calls.every(([route]) => route === "models/runtime")).toBe(true);
  });
  it("Pi-listed thinking choices save exactly and failed validation keeps the draft", async () => {
    const { tree, factory } = await openControl();
    expect(button(tree, "high")).toBeUndefined();
    button(tree, "low").onPress!();
    hooks.rpc.mockRejectedValue(new Error("Pi validation failed"));
    button(render(factory), "Save").onPress!();
    await flush();
    const next = render(factory);
    expect(text(next)).toContain("Pi validation failed");
    expect(hooks.rpc).toHaveBeenCalledWith("bots/update", {
      botId: "bot",
      modelProvider: requested.provider,
      modelId: requested.modelId,
      thinkingLevel: "low",
    });
    expect(button(next, "Save").disabled).toBe(false);
  });
  it("unavailable scoped refresh preserves the stale request and disables writes", async () => {
    const { tree, factory } = await openControl({ threadId: "thread" });
    hooks.rpc.mockResolvedValue({
      ...snapshot(),
      catalog: [],
      current: null,
      selection: null,
      availability: { status: "unavailable", error: "Pi unavailable" },
    });
    button(tree, "Refresh").onPress!();
    render(factory);
    await flush();
    const next = render(factory);
    expect(text(next)).toContain(modelIdentity(requested));
    expect(text(next)).toContain(modelIdentity(current));
    expect(text(next)).toContain("Pi unavailable");
    expect(hooks.rpc).toHaveBeenLastCalledWith("models/runtime", {
      botId: "bot",
      threadId: "thread",
      refresh: true,
    });
    expect(button(next, "Save").disabled).toBe(true);
  });
  it("global inventory reads only {}, labels the profile default, and searches real identities", async () => {
    render(Models);
    await flush();
    let tree = render(Models);
    expect(hooks.rpc).toHaveBeenCalledExactlyOnceWith("models/runtime", {});
    expect(text(tree)).toContain("Pi profile default");
    expect(text(tree)).toContain("profile-id");
    expect(text(tree)).not.toContain("current-id");
    expect(nodes(tree).filter((node) => node.onPress)).toHaveLength(1);
    nodes(tree).find((node) => node.accessibilityLabel === "Search models")!.onChangeText!(
      "other-provider real-id",
    );
    tree = render(Models);
    expect(nodes(tree).find((node) => node.data)!.data).toHaveLength(1);
  });
  it("bot scope saves through bots/update, without claiming requested is current", async () => {
    const { tree } = await openControl();
    expect(hooks.rpc).toHaveBeenCalledWith("models/runtime", { botId: "bot" });
    expect(text(tree)).toContain(`Current: ${modelIdentity(current)}`);
    expect(text(tree)).toContain(`Requested: ${modelIdentity(requested)} · Pending`);
    expect(button(tree, "Save").disabled).toBe(false);
    await button(tree, "Save").onPress!();
    await flush();
    expect(hooks.rpc).toHaveBeenCalledWith("bots/update", {
      botId: "bot",
      modelProvider: requested.provider,
      modelId: requested.modelId,
      thinkingLevel: null,
    });
  });
  it.each([{ threadId: "thread" }, { threadId: "thread", participantId: "worker" }])(
    "worker scope writes acknowledged intent and can clear it: %j",
    async (worker) => {
      const { tree, factory } = await openControl(worker);
      hooks.rpc.mockImplementation((route) =>
        Promise.resolve(route === "models/setWorkerSelection" ? snapshot().selection : snapshot()),
      );
      await button(tree, "Save").onPress!();
      await flush();
      expect(hooks.rpc).toHaveBeenCalledWith("models/setWorkerSelection", {
        botId: "bot",
        ...worker,
        selection: requested,
      });
      expect(text(render(factory))).toContain(`Current: ${modelIdentity(current)}`);
      await flush();
      await button(render(factory), worker.participantId ? "Use bot model" : "Use Pi selection")
        .onPress!();
      await flush();
      expect(hooks.rpc).toHaveBeenCalledWith("models/setWorkerSelection", {
        botId: "bot",
        ...worker,
        selection: null,
      });
    },
  );
  it("preserves stale selected identities and unsupported thinking without substituting a model", async () => {
    const stale = { ...requested, modelId: "removed-id", thinkingLevel: "high" as const };
    const { tree } = await openControl(undefined, stale);
    expect(button(tree, "Save").disabled).toBe(true);
    const list = nodes(tree).find((node) => node.data)!;
    expect(
      list.data!.find((entry) => entry.key === modelKey(stale.provider, stale.modelId))?.label,
    ).toContain("removed-id");
    expect(text(tree)).toContain("Thinking: high · Unavailable");
    expect(text(tree)).not.toContain("xhigh");
  });
  it("refresh rejection preserves inventory and current, blocks writes, and permits recovery", async () => {
    const { tree, factory } = await openControl();
    hooks.rpc.mockRejectedValue(new Error("Offline"));
    button(tree, "Refresh").onPress!();
    render(factory);
    await flush();
    let next = render(factory);
    expect(text(next)).toContain("Offline");
    expect(text(next)).toContain(modelIdentity(current));
    expect(nodes(next).find((node) => node.data)!.data).toHaveLength(2);
    expect(button(next, "Save").disabled).toBe(true);
    hooks.rpc.mockResolvedValue(snapshot());
    button(next, "Refresh").onPress!();
    render(factory);
    await flush();
    next = render(factory);
    expect(button(next, "Save").disabled).toBe(false);
  });
  it("failed worker status remains separate from current and displays its error", async () => {
    const failed = snapshot();
    failed.selection!.status = "failed";
    failed.selection!.error = "Pi rejected selection";
    hooks.rpc.mockResolvedValue(failed);
    const { tree } = await openControl({ threadId: "thread" });
    expect(text(tree)).toContain("Failed");
    expect(text(tree)).toContain("Pi rejected selection");
    expect(text(tree)).toContain(`Current: ${modelIdentity(current)}`);
  });
  it("search and unavailable refresh retain exact Pi inventory, without synthetic levels", () => {
    const previous = snapshot();
    expect(searchPiModels(previous.catalog, "OTHER-provider REAL-id")).toHaveLength(1);
    expect(searchPiModels(previous.catalog, "unknown")).toHaveLength(0);
    const next = retainPiInventory(previous, {
      ...previous,
      catalog: [],
      profileDefault: null,
      availability: { status: "unavailable", error: "Offline" },
    });
    expect(next.catalog).toEqual(previous.catalog);
    expect(next.profileDefault).toEqual(previous.profileDefault);
    expect(next.catalog[0]!.thinkingLevels).toEqual(["off", "low"]);
  });
});
