import type { ReactNode } from "react";

export function MessageHoverMetadata({
  side,
  pinned = false,
  below = false,
  children,
}: {
  side: "start" | "end";
  pinned?: boolean;
  below?: boolean;
  children: ReactNode;
}) {
  // Touch exposes More; hover-capable pointers reveal the full rail on demand.
  const reveal = pinned
    ? "pointer-events-auto opacity-100"
    : "pointer-events-auto opacity-100 [@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:focus-within:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:focus-within:opacity-100";

  return (
    <div
      data-testid="message-hover-rail"
      className={`absolute z-10 flex items-center transition-opacity ${reveal} ${
        below
          ? "top-full end-0 mt-1"
          : `top-1/2 -translate-y-1/2 ${side === "end" ? "start-full ms-1" : "end-full me-1"}`
      }`}
    >
      {children}
    </div>
  );
}
