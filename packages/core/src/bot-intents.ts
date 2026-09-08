/** Ordinary user messages; office tools and execution remain server-owned. */
export const BOT_OFFICE_PROMPTS = {
  link: "Help me link an office for this bot.",
  move: "Help me move this bot to another office.",
} as const;

/** Send to this bot's conversation, not whichever thread is currently selected. */
export type BotPromptHandler = (botId: string, text: string) => Promise<void>;
