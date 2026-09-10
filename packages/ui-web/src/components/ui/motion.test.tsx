import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpringAside, SpringButton, SpringDisclosure, SpringWidth, shellSpring } from "./motion";

const state = vi.hoisted(() => ({ reduced: false, props: {} as Record<string, unknown> }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: () => state.reduced,
}));
vi.mock("framer-motion", () => ({
  motion: Object.fromEntries(
    ["aside", "button", "div"].map((tag) => [
      tag,
      (props: Record<string, unknown>) => {
        state.props = props;
        return null;
      },
    ]),
  ),
}));

beforeEach(() => {
  state.reduced = false;
});
describe("shell motion", () => {
  it("shares a spring without animating initial mount", () => {
    renderToStaticMarkup(<SpringAside animate={{ width: 316 }} />);
    expect(state.props.transition).toBe(shellSpring);
    expect(state.props.initial).toBe(false);
    renderToStaticMarkup(<SpringButton animate={{ insetInlineStart: 308 }} />);
    expect(state.props.transition).toBe(shellSpring);
    renderToStaticMarkup(<SpringWidth width={36} />);
    expect(state.props.animate).toEqual({ width: 36 });
    expect(state.props.initial).toBe(false);
  });
  it("makes closing content inaccessible immediately", () => {
    renderToStaticMarkup(
      <SpringDisclosure open={false}>
        <button type="button">Hidden</button>
      </SpringDisclosure>,
    );
    expect(state.props.inert).toBe(true);
    expect(state.props["aria-hidden"]).toBe(true);
    expect(state.props.animate).toEqual({ height: 0, opacity: 0 });
  });
  it("settles reduced motion directly in styles", () => {
    state.reduced = true;
    renderToStaticMarkup(<SpringAside animate={{ width: 0, x: 0 }} />);
    expect(state.props.animate).toBeUndefined();
    expect(state.props.style).toEqual({ width: 0, x: 0 });
    renderToStaticMarkup(<SpringButton animate={{ opacity: 0 }} />);
    expect(state.props.animate).toBeUndefined();
    expect(state.props.style).toEqual({ opacity: 0 });
    renderToStaticMarkup(
      <SpringDisclosure open={false}>
        <button type="button">Hidden</button>
      </SpringDisclosure>,
    );
    expect(state.props.animate).toBeUndefined();
    expect(state.props.style).toMatchObject({ height: 0, opacity: 0 });
    renderToStaticMarkup(
      <SpringDisclosure open>
        <button type="button">Visible</button>
      </SpringDisclosure>,
    );
    expect(state.props.style).toMatchObject({ height: "auto", opacity: 1 });
    expect(state.props.inert).toBe(false);
  });
});
