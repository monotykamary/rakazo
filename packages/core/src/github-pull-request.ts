import { cloudAgentHttpsUrl } from "./cloud-agent.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** GitHub html_url for a pull request that has actually merged. */
export function mergedPullRequestUrl(
  event: string,
  payload: Record<string, unknown>,
): string | undefined {
  if (event !== "pull_request") return undefined;
  const pullRequest = record(payload.pull_request);
  if (pullRequest?.merged !== true) return undefined;
  const url = typeof pullRequest.html_url === "string" ? pullRequest.html_url : undefined;
  return cloudAgentHttpsUrl(url);
}
