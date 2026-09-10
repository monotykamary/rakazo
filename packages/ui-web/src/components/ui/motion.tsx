import { motion } from "framer-motion";
import { type ComponentPropsWithoutRef, useSyncExternalStore } from "react";

export const shellSpring = { type: "spring", stiffness: 420, damping: 42, mass: 0.8 } as const;

function subscribeMedia(query: string, notify: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}

export function useMotionMedia(query: string) {
  return useSyncExternalStore(
    (notify) => subscribeMedia(query, notify),
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useShellMotion() {
  const reduced = useMotionMedia("(prefers-reduced-motion: reduce)");
  return { reduced, transition: reduced ? { duration: 0 } : shellSpring };
}

type ShellTarget = {
  width?: number | string;
  x?: number | string;
  insetInlineStart?: number;
  opacity?: number;
};
type SpringProps<Tag extends "aside" | "button"> = Omit<
  ComponentPropsWithoutRef<Tag>,
  "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart"
> & {
  animate: ShellTarget;
};

export function SpringAside({ animate, style, ...props }: SpringProps<"aside">) {
  const { reduced, transition } = useShellMotion();
  return (
    <motion.aside
      {...props}
      style={{ ...style, ...(reduced ? animate : {}) }}
      animate={reduced ? undefined : animate}
      initial={false}
      transition={transition}
    />
  );
}

export function SpringButton({ animate, style, ...props }: SpringProps<"button">) {
  const { reduced, transition } = useShellMotion();
  return (
    <motion.button
      {...props}
      style={{ ...style, ...(reduced ? animate : {}) }}
      animate={reduced ? undefined : animate}
      initial={false}
      transition={transition}
    />
  );
}

export function SpringWidth({
  width,
  className,
  children,
}: {
  width: number;
  className?: string;
  children: React.ReactNode;
}) {
  const { reduced, transition } = useShellMotion();
  return (
    <motion.div
      className={className}
      initial={false}
      animate={reduced ? undefined : { width }}
      style={reduced ? { width } : undefined}
      transition={transition}
    >
      {children}
    </motion.div>
  );
}

export function SpringDisclosure({ open, children }: { open: boolean; children: React.ReactNode }) {
  const { reduced, transition } = useShellMotion();
  return (
    <motion.div
      initial={false}
      animate={reduced ? undefined : { height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
      style={
        reduced
          ? { height: open ? "auto" : 0, opacity: open ? 1 : 0, overflow: "hidden" }
          : { overflow: "hidden" }
      }
      transition={transition}
      inert={!open}
      aria-hidden={!open || undefined}
    >
      {children}
    </motion.div>
  );
}
