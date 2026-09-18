import { describe, expect, it } from "vitest";
import { plainTextFromMarkdown, truncatedPlainText } from "./markdown-plain.js";

describe("plain Markdown previews", () => {
  it.each([
    ["Created **Projects-CoS** as a **Project**", "Created Projects-CoS as a Project"],
    ["# Status\n- see [report](https://example.com)\n1) done", "Status see report done"],
    ["```ts\nconst x = 1;\n```", "const x = 1;"],
    ["~~~txt\nready\n~~~", "ready"],
    ["Use `code` and ~~old~~ _new_", "Use code and old new"],
    ["![diagram](https://example.com/a.png)", "diagram"],
    ["\r\n> ready\r\n", "ready"],
    ["   **  **   ", ""],
    ["", ""],
  ])("renders %s", (source, text) => {
    expect(plainTextFromMarkdown(source)).toBe(text);
  });
  it("strips before truncation", () => {
    expect(truncatedPlainText("**Ready** for review", 7)).toBe("Ready f");
  });
});
