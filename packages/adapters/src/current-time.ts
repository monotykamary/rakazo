/** Explicit clock anchor for models and review/compaction helpers. */
export function formatCurrentTimeInstruction(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
    now,
  );
  return `Current date and time: ${weekday}, ${iso} (UTC). Use this as the present moment, not dates from training data or quoted history. Convert to the user's time zone when known.`;
}
