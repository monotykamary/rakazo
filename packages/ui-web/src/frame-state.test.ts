import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFramePublisher } from "./frame-state.js";

let frames: Map<number, FrameRequestCallback>;
let nextId: number;
function paint() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}
beforeEach(() => {
  frames = new Map();
  nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());

describe("frame publication", () => {
  it("publishes one latest snapshot for a burst of 1000 ordered reducer results", () => {
    const commit = vi.fn();
    const publisher = createFramePublisher(commit);
    for (let cursor = 0; cursor < 1000; cursor++) publisher.publish({ cursor });
    expect(frames.size).toBe(1);
    expect(commit).not.toHaveBeenCalled();
    paint();
    expect(commit).toHaveBeenCalledExactlyOnceWith({ cursor: 999 });
    publisher.publish({ cursor: 1000 });
    paint();
    expect(commit).toHaveBeenLastCalledWith({ cursor: 1000 });
  });

  it("immediately publishes navigation or terminal state without a stale follow-up paint", () => {
    const commit = vi.fn();
    const publisher = createFramePublisher(commit);
    publisher.publish("progress");
    publisher.publish("completed", true);
    expect(commit).toHaveBeenCalledExactlyOnceWith("completed");
    expect(frames.size).toBe(0);
    paint();
    expect(commit).toHaveBeenCalledTimes(1);
    publisher.publish("next-thread", true);
    expect(commit).toHaveBeenLastCalledWith("next-thread");
  });

  it("cancels unmounted paints and can resume after a strict-mode effect restart", () => {
    const commit = vi.fn();
    const publisher = createFramePublisher(commit);
    publisher.publish(null);
    publisher.cancel();
    paint();
    expect(commit).not.toHaveBeenCalled();
    publisher.publish("fresh");
    paint();
    expect(commit).toHaveBeenCalledExactlyOnceWith("fresh");
  });
});
