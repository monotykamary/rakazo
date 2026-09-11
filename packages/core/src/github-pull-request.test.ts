import { describe, expect, it } from "vitest";
import { mergedPullRequestUrl } from "./github-pull-request.js";

describe("merged pull request url", () => {
  it("accepts a merged GitHub html url", () => {
    expect(
      mergedPullRequestUrl("pull_request", {
        action: "closed",
        pull_request: {
          merged: true,
          html_url: "https://github.com/example/repo/pull/12",
        },
      }),
    ).toBe("https://github.com/example/repo/pull/12");
  });

  it("ignores closed PRs that did not merge", () => {
    expect(
      mergedPullRequestUrl("pull_request", {
        action: "closed",
        pull_request: {
          merged: false,
          html_url: "https://github.com/example/repo/pull/12",
        },
      }),
    ).toBeUndefined();
  });
});
