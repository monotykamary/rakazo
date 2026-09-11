import { i18n } from "@lingui/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));

import { ComposerOpsPills } from "./ComposerOpsPills";

i18n.load("en", {});
i18n.activate("en");

describe("composer ops pills", () => {
  it("adds no chrome when nothing is live", () => {
    expect(
      renderToString(
        <ComposerOpsPills ops={{ working: [], pullRequests: [], listening: [] }} />,
      ),
    ).toBe("");
  });

  it("shows only the counts that have work", () => {
    const html = renderToString(
      <ComposerOpsPills
        ops={{
          working: [{ id: "run", botId: "bot", name: "Scout" }],
          pullRequests: [],
          listening: [{ id: "watch", name: "Merge watch" }],
        }}
      />,
    );
    expect(html).toContain('data-testid="composer-ops-working"');
    expect(html).toContain('aria-label="Working, 1"');
    expect(html).toContain('data-testid="composer-ops-listening"');
    expect(html).toContain('aria-label="Listening, 1"');
    expect(html).not.toContain("composer-ops-prs");
  });
});
