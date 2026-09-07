import { useEffect, useState } from "react";

/** Coalesce paints, never the underlying event reducer or durable cursor updates. */
export function createFramePublisher<T>(commit: (value: T) => void) {
  let frame: number | undefined;
  let latest: T;
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  return {
    cancel,
    publish(value: T, immediate = false) {
      latest = value;
      if (immediate) {
        cancel();
        commit(value);
      } else if (frame === undefined) {
        frame = requestAnimationFrame(() => {
          frame = undefined;
          commit(latest);
        });
      }
    },
  };
}

/** Browser paint state only; callers keep authoritative event state in their own ref. */
export function useFrameState<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const [publisher] = useState(() => createFramePublisher<T>(setValue));
  useEffect(() => () => publisher.cancel(), [publisher]);
  return [value, publisher.publish] as const;
}
