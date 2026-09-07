import type { Extension, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Adapt the reviewed upstream extension before binding it to an isolated worker. */
export function manageModelVisibilityExtension(extension: Extension, scratchCwd: string): void {
  const command = extension.commands.get("hide-models");
  const startup = extension.handlers.get("session_start");
  if (!command || !startup?.length)
    throw new Error("Pinned pi-hide-providers lacks its expected command or startup hook");

  // Upstream reads cwd config even when the project is untrusted. Only this extension
  // receives scratch cwd; computer projects must never override account preferences.
  extension.handlers.set(
    "session_start",
    startup.map(
      (handler) => async (event, context) =>
        handler(event, { ...(context as ExtensionContext), cwd: scratchCwd }),
    ),
  );
  // Replace, do not register a duplicate command: Pi exposes duplicate names with suffixes.
  // Real provider rules cannot match the worker's rakazo-broker identity. Backend model
  // selection and request brokers enforce them; local add/remove/reset must not pretend to.
  extension.commands.set("hide-models", {
    ...command,
    getArgumentCompletions: undefined,
    description: "Manage model visibility in Rakazo settings",
    handler: async () => {
      throw new Error("Change model visibility in Rakazo model settings.");
    },
  });
}
