import type { Extension } from "@earendil-works/pi-coding-agent";

/** Adapt the reviewed upstream extension before binding it to an isolated worker. */
export function manageVisionHandoffExtension(extension: Extension): void {
  const command = extension.commands.get("vision-handoff");
  if (!command) throw new Error("Pinned pi-vision-handoff lacks its expected command");
  extension.commands.set("vision-handoff", {
    ...command,
    getArgumentCompletions: undefined,
    description: "Manage vision handoff in Rakazo settings",
    handler: async () => {
      throw new Error("Change vision handoff in Rakazo model settings.");
    },
  });
}
