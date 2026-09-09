import { motion } from "framer-motion";
import { useShellMotion } from "./motion";

// Matching cubic segments let interrupted transitions morph from their current shape.
const shapes = {
  send: ["M12 19 C12 19 12 12 12 12 C12 12 12 5 12 5", "M5 12 C5 12 12 5 12 5 C12 5 19 12 19 12"],
  steer: ["M4 4 C4 4 4 12 8 12 C8 12 20 12 20 12", "M14 6 C14 6 20 12 20 12 C20 12 14 18 14 18"],
  followUp: [
    "M11 5 C11 5 16 5 16 5 C16 5 21 5 21 5",
    "M11 12 C11 12 16 12 16 12 C16 12 21 12 21 12",
  ],
  edit: ["M9 16 C9 16 14 11 14 11 C14 11 20 5 20 5", "M4 11 C4 11 9 16 9 16 C9 16 20 5 20 5"],
} as const;

export function ComposerActionIcon({ mode }: { mode: keyof typeof shapes }) {
  const { reduced, transition } = useShellMotion();
  const queueOpacity = mode === "followUp" ? 1 : 0;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-composer-icon={mode}
    >
      {shapes[mode].map((d, index) => {
        const opacity = mode === "edit" && index === 0 ? 0 : 1;
        return (
          <motion.path
            key={index}
            initial={false}
            d={reduced ? d : undefined}
            opacity={reduced ? opacity : undefined}
            animate={reduced ? undefined : { d, opacity }}
            transition={transition}
          />
        );
      })}
      <motion.g
        initial={false}
        opacity={reduced ? queueOpacity : undefined}
        animate={reduced ? undefined : { opacity: queueOpacity }}
        transition={transition}
      >
        <path d="M11 19h10" />
        <path d="M4 4h1v5 M4 9h2" />
        <path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02" />
      </motion.g>
    </svg>
  );
}
