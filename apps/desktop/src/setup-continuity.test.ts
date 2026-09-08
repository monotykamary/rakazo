import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { DesktopSetup } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

class Element {
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  name = "";
  textContent = "";
  dataset = {};
  listeners = new Map<string, (event: unknown) => void>();
  addEventListener(event: string, listener: (event: unknown) => void) {
    this.listeners.set(event, listener);
  }
  setAttribute() {}
  removeAttribute() {}
  focus() {}
  emit(event: string, data: unknown = {}) {
    this.listeners.get(event)?.(data);
  }
}
async function setup(saved: DesktopSetup | null) {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const local = element("mode-new");
  local.value = "new";
  local.name = "mode";
  const remote = element("mode-existing");
  remote.value = "existing";
  remote.name = "mode";
  local.checked = saved?.mode !== "existing";
  remote.checked = !local.checked;
  const form = Object.assign(element("setup"), {
    querySelector: () => (remote.checked ? remote : local),
    querySelectorAll: () => [local, remote],
  });
  const bridge = {
    state: vi.fn(async () => ({ saved, defaultLocalUrl: "http://127.0.0.1:45173" })),
    save: vi.fn(async () => ({ ok: true })),
    quit: vi.fn(),
    stack: { state: vi.fn(async () => ({ phase: "idle" })), start: vi.fn() },
  };
  vm.runInNewContext(readFileSync(new URL("./setup.js", import.meta.url), "utf8"), {
    URL,
    HTMLElement: Element,
    HTMLInputElement: Element,
    document: {
      documentElement: { dataset: {} },
      getElementById: element,
      querySelector: (query: string) => (query.includes('value="existing"') ? remote : local),
    },
    window: { rakazoSetup: bridge },
  });
  await vi.waitFor(() => expect(bridge.stack.state).toHaveBeenCalled());
  return { element, form, bridge, local, remote };
}

describe("desktop continuity setup", () => {
  it("connects to a saved server without starting local services; quit only closes the client", async () => {
    const f = await setup({ mode: "existing", serverUrl: "https://app.example.com" });
    expect(f.element("server-url").value).toBe("https://app.example.com");
    expect(f.element("panel-new").hidden).toBe(true);
    expect(f.element("server-switch-notice").hidden).toBe(true);
    f.element("quit").emit("click");
    expect(f.bridge.quit).toHaveBeenCalledOnce();
    expect(f.bridge.stack.start).not.toHaveBeenCalled();
    f.form.emit("submit", { preventDefault() {} });
    await vi.waitFor(() =>
      expect(f.bridge.save).toHaveBeenCalledWith({
        mode: "existing",
        serverUrl: "https://app.example.com",
      }),
    );
    expect(f.bridge.stack.start).not.toHaveBeenCalled();
  });

  it("reveals the no-migration notice only when changing an existing server", async () => {
    const f = await setup({ mode: "existing", serverUrl: "https://app.example.com" });
    f.element("server-url").value = "https://other.example.com";
    f.element("server-url").emit("input");
    expect(f.element("server-switch-notice").hidden).toBe(false);
    expect(f.bridge.save).not.toHaveBeenCalled();
    f.element("server-url").value = "https://app.example.com/";
    f.element("server-url").emit("input");
    expect(f.element("server-switch-notice").hidden).toBe(true);
    const fresh = await setup(null);
    expect(fresh.element("server-switch-notice").hidden).toBe(true);
  });

  it("ships progressive server installation guidance without claiming local sleep independence", () => {
    const html = readFileSync(new URL("./setup.html", import.meta.url), "utf8");
    expect(html).toContain("Bots pause when this computer sleeps.");
    expect(html).toContain('<details class="server-guide">');
    expect(html).toContain("infra/compose/deploy-server.sh");
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const quit = main.slice(main.indexOf('app.on("before-quit"'));
    expect(quit).not.toContain(".stop(");
    expect(quit).not.toContain("threads.stop");
  });
});
