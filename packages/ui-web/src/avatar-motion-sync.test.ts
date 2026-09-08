import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Shape-family loop lengths live in mobile Reanimated worklets and are mirrored
// by the web CSS below. This test keeps both surfaces honest until the shared
// choreography lands in @rakazo/core.
const MOBILE_AVATAR_MOTION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/mobile/lib/avatar-motion.ts",
);

/** CSS data-shape-family order → expected duration seconds. */
const FAMILY_DURATION_SECONDS = [1.8, 1.35, 1.6, 2.4, 2.4, 1.35, 1.1, 1.35, 1.6, 1.35] as const;

function workingDurationSecondsForFamily(css: string, family: number): number | null {
  // Split on rule closers so a wrong duration cannot match a later family's token.
  for (const chunk of css.split("}")) {
    if (!chunk.includes(`data-shape-family="${family}"`)) continue;
    if (!chunk.includes(".rakazo-organic-avatar-body-working")) continue;
    const match = chunk.match(/animation:\s*[^;]*?\s([\d.]+)s\b/);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

function mobileDurationsMs(source: string): number[] {
  const match = source.match(/WORKING_DURATIONS_MS\s*=\s*\[([^\]]+)\]/);
  expect(match).toBeTruthy();
  return (match?.[1] ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => !Number.isNaN(value));
}

describe("organic working avatar CSS", () => {
  it("keeps each shape-family duration aligned with the mobile worklet math", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "styles.css"),
      "utf8",
    );
    const mobileMs = mobileDurationsMs(readFileSync(MOBILE_AVATAR_MOTION, "utf8"));
    expect(mobileMs).toHaveLength(FAMILY_DURATION_SECONDS.length);
    for (let family = 0; family < FAMILY_DURATION_SECONDS.length; family += 1) {
      const seconds = FAMILY_DURATION_SECONDS[family]!;
      expect(mobileMs[family]! / 1000).toBe(seconds);
      expect(workingDurationSecondsForFamily(css, family)).toBe(seconds);
    }
  });
});
