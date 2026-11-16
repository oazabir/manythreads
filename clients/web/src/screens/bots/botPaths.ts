import { BRAIN_BOT_SLUG } from '@manythreads/shared';

/*
 * Where a bot's three places are (P29-13): its chat (the default way in), its settings (everything about how it is set up) and its usage. `/bots/<bot>` itself is the way in
 * the sidebar uses: it opens the chat, or says there is none (`BotHome`).
 */

/** The bot's chat. Brain's conversations live in Chat. */
export const botChatPath = (team: string, botSlug: string): string => (botSlug === BRAIN_BOT_SLUG ? `/t/${team}/chat?bot=brain` : `/t/${team}/bots/${encodeURIComponent(botSlug)}/chat`);

/** The bot's settings, optionally on one tab (a group id or an old section id). */
export const botSettingsPath = (team: string, botSlug: string, tab?: string): string => `/t/${team}/bots/${encodeURIComponent(botSlug)}/settings${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`;

/** The way in from a list: chat when the bot has one, else the page that says so. */
export const botHomePath = (team: string, botSlug: string): string => `/t/${team}/bots/${encodeURIComponent(botSlug)}`;
