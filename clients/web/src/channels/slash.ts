import { parseSlash, SLASH_COMMANDS, type SlashCommand } from '@manythreads/shared';

/*
 * What a slash command does once the composer reads it (PLAN P14-06). `parseSlash` in `@manythreads/shared` says which command a message is;
 * this file decides, from facts the page already holds, whether the person may run it and what to do: post a message, create a card, show
 * the list, or say in one plain sentence why not. It runs nothing itself, so it is tested without a browser. The server stays the authority:
 * a command the page lets through can still be refused there, and the screen shows that sentence.
 */

/** A bot the team has, as `/ask` needs it. */
export type SlashBot = { slug: string; name: string };

/** The page's facts about the person and the conversation. */
export type SlashWho = {
  guest: boolean;
  /** A member of the team this conversation belongs to, or a workspace admin. */
  teamMember: boolean;
  /** The team is archived: it takes no new cards. */
  teamArchived: boolean;
  /** The team's bots that answer (turned on and valid), or null while the list has not arrived or could not be read. */
  bots: readonly SlashBot[] | null;
  /** The signed-in person's display name, when the roster has answered (for `/me`). */
  selfName: string | null;
};

export type Availability = { ok: true } | { ok: false; reason: string };

export const NO_CARD_AS_GUEST = 'Guests cannot create cards.';
export const NO_BOT_AS_GUEST = 'Guests cannot ask bots with a command.';

/** Whether this person can use the command right now, and if not, why (the menu shows the reason beside the command). */
export function availability(command: SlashCommand, who: SlashWho): Availability {
  if (command.needs === 'anyone') return { ok: true };
  if (who.guest) return { ok: false, reason: command.name === 'task' ? NO_CARD_AS_GUEST : NO_BOT_AS_GUEST };
  if (!who.teamMember) return { ok: false, reason: command.name === 'task' ? 'Only members of this team can create cards.' : 'Only members of this team can ask its bots.' };
  if (command.name === 'task' && who.teamArchived) return { ok: false, reason: 'This team is archived, so it cannot get new cards.' };
  if (command.name === 'ask' && who.bots !== null && who.bots.length === 0) return { ok: false, reason: 'This team has no bots that can answer yet.' };
  return { ok: true };
}

/** Every command with its availability, in list order. */
export function commandChoices(who: SlashWho): Array<{ command: SlashCommand; availability: Availability }> {
  return SLASH_COMMANDS.map((command) => ({ command, availability: availability(command, who) }));
}

export type SlashPlan =
  /** Post this text (with the files, if any) the way any message is posted. */
  | { do: 'post'; body: string }
  | { do: 'task'; title: string }
  | { do: 'help' }
  /** Nothing is sent and the text stays in the box; the sentence says what to fix. */
  | { do: 'say'; message: string };

export const TITLE_MAX = 200;
const MAX_NAMED = 5;

/** `/shrug` as it is stored: the backslash and underscores are escaped so the message renderer draws the whole face. */
export const SHRUG = '¯\\\\\\_(ツ)\\_/¯';

function botByWord(word: string, bots: readonly SlashBot[]): SlashBot | undefined {
  const w = word.replace(/^@/, '').toLowerCase();
  return bots.find((b) => b.slug.toLowerCase() === w) ?? bots.find((b) => b.name.toLowerCase().replace(/\s+/g, '-') === w);
}

/** Plans one message about to be sent: whatever is not a command, or not a known one, is simply posted. `hasFiles`: files are attached to the message. */
export function planSlash(text: string, who: SlashWho, hasFiles = false): SlashPlan {
  const parsed = parseSlash(text);
  if (parsed.kind === 'text') return { do: 'post', body: parsed.body };
  const { command, args } = parsed;
  const can = availability(command, who);
  if (!can.ok) return { do: 'say', message: can.reason };
  if ((command.name === 'task' || command.name === 'help') && hasFiles) {
    return { do: 'say', message: `Remove the attached files first: /${command.name} does not post a message.` };
  }
  switch (command.name) {
    case 'help':
      // "/help me with this" is a sentence, not the command: keep it in the box rather than open a dialog and empty it
      if (args !== '') return { do: 'say', message: 'Type /help on its own to see the commands. To post this as a message, start it with two slashes: //help.' };
      return { do: 'help' };
    case 'shrug':
      return { do: 'post', body: args === '' ? SHRUG : `${args} ${SHRUG}` };
    case 'me': {
      const line = args.replace(/\s*\n\s*/g, ' ');
      if (line === '') return { do: 'say', message: 'Say what you are doing after /me, for example /me is at lunch.' };
      return { do: 'post', body: `*${who.selfName ? `${who.selfName} ` : ''}${line}*` };
    }
    case 'task': {
      const title = args.replace(/\s*\n\s*/g, ' ');
      if (title === '') return { do: 'say', message: 'Give the card a title after /task, for example /task Fix the login redirect.' };
      if (title.length > TITLE_MAX) return { do: 'say', message: `A card title can be at most ${TITLE_MAX} characters. This one has ${title.length}.` };
      return { do: 'task', title };
    }
    case 'ask': {
      const space = args.search(/\s/);
      const word = space === -1 ? args : args.slice(0, space);
      const question = space === -1 ? '' : args.slice(space).trim();
      if (word === '') return { do: 'say', message: 'Say which bot and what to ask, for example /ask coder how do I run the tests?' };
      if (who.bots === null) return { do: 'say', message: 'The list of bots is not ready yet. Try again in a moment, or mention the bot with @ instead.' };
      const bot = botByWord(word, who.bots);
      if (!bot) {
        const names = who.bots.slice(0, MAX_NAMED).map((b) => b.slug).join(', ');
        return { do: 'say', message: `There is no bot called “${word.replace(/^@/, '')}” in this team.${names ? ` Bots here: ${names}.` : ''}` };
      }
      if (question === '') return { do: 'say', message: `Add your question after the bot’s name, for example /ask ${bot.slug} how do I run the tests?` };
      return { do: 'post', body: `@${bot.slug} ${question}` };
    }
    default:
      // a command in the list that this page does not run yet: post what was typed rather than lose it
      return { do: 'post', body: text.trim() };
  }
}

/** The plain sentence for a refused card: the server's own sentence for a closed set of answers, otherwise a general one. */
export function taskFailureText(status: number | undefined, message: string | undefined): string {
  if (status === 403) return 'You are not allowed to create cards in this team.';
  if (status === 404) return 'This team could not be found. It may have been renamed or removed.';
  if (status === 429) return 'Too many cards in a short time. Wait a moment and try again.';
  if (message && status !== undefined && status < 500) return message;
  return 'The card could not be created just now. Try again in a moment.';
}
