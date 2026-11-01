import {
  parseDndArgs,
  parseInviteArgs,
  parseMuteArgs,
  parsePollArgs,
  parseRemindArgs,
  parseSlash,
  parseStatusArgs,
  parseTopicArgs,
  SLASH_COMMANDS,
  type SlashCommand,
} from '@manythreads/shared';

/*
 * What a slash command does once the composer reads it (PLAN P14-06). `parseSlash` in `@manythreads/shared` says which command a message is;
 * this file decides, from facts the page already holds, whether the person may run it and what to do: post a message, create a card, show
 * the list, or say in one plain sentence why not. It runs nothing itself, so it is tested without a browser (slashRun.ts carries a plan out
 * through the routes of the plugin that owns the thing). The server stays the authority: a command the page lets through can still be
 * refused there, and the screen shows that sentence.
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
  /**
   * The conversation: what the person is in it. Absent or null while it has not arrived; the commands that need it (`/invite`, `/leave`, `/topic`,
   * `/mute`, `/remind @person`) then ask the person to try again in a moment.
   */
  where?: SlashWhere | null;
};

export type SlashWhere = {
  channelId: string;
  /** A channel of a team, or a direct message (nobody is added to or leaves a direct message, and it has no topic). */
  kind: 'channel' | 'dm';
  isMember: boolean;
  /** A team lead or a workspace admin: may add people and change the topic. */
  canManage: boolean;
};

/** Who a reminder is for, with plain ids (the runner checks them against the API schema when it sends). */
export type RemindTarget = { kind: 'me' } | { kind: 'person'; personId: string; channelId: string } | { kind: 'channel'; channelId: string };

export type SlashPerson = { personId: string; name: string; handle: string };

/** What a command needs to find in the page besides the person's rights: the clock, the zone, the roster and the channels of the team. */
export type SlashEnv = {
  now: Date;
  /** An IANA zone name, the person's own (the browser's). */
  timeZone: string;
  people: readonly SlashPerson[];
  channels: ReadonlyArray<{ id: string; name: string }>;
  selfPersonId: string | null;
};

export function defaultEnv(): SlashEnv {
  let timeZone = 'UTC';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    // an engine without Intl zones: UTC
  }
  return { now: new Date(), timeZone, people: [], channels: [], selfPersonId: null };
}

export type Availability = { ok: true } | { ok: false; reason: string };

export const NO_CARD_AS_GUEST = 'Guests cannot create cards.';
export const NO_BOT_AS_GUEST = 'Guests cannot ask bots with a command.';

export const NO_REMINDER_AS_GUEST = 'Guests cannot set reminders.';
export const WHERE_LOADING = 'This conversation is still loading. Try again in a moment.';
export const NO_MANAGE = 'Only a team lead or a workspace admin can do that in this channel.';

/** Whether this person can use the command right now, and if not, why (the menu shows the reason beside the command). */
export function availability(command: SlashCommand, who: SlashWho): Availability {
  if (command.name === 'remind' && who.guest) return { ok: false, reason: NO_REMINDER_AS_GUEST };
  if (command.needs === 'anyone') return { ok: true };
  if (command.needs === 'channel_member') {
    if (!who.where) return { ok: false, reason: WHERE_LOADING };
    if (who.where.kind !== 'channel') return { ok: false, reason: 'You cannot leave a direct message.' };
    if (!who.where.isMember) return { ok: false, reason: 'You are not a member of this channel.' };
    return { ok: true };
  }
  if (command.needs === 'channel_manager') {
    if (!who.where) return { ok: false, reason: WHERE_LOADING };
    if (who.where.kind !== 'channel') return { ok: false, reason: 'A direct message has no topic, and nobody can be added to it.' };
    if (!who.where.canManage) return { ok: false, reason: NO_MANAGE };
    return { ok: true };
  }
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
  /** `/poll` alone opens the dialog empty; with a question and options it asks the poll at once. */
  | { do: 'poll'; question: string | null; options: string[]; prefill?: { question: string; options: string[] } }
  /** `/remind` alone or `/remind list`: show the reminders this person set. */
  | { do: 'remind-list' }
  /** A reminder, fully worked out: the exact moment (an ISO instant in the person's zone), the target, the one-line text and who it is for in words. */
  | { do: 'remind'; target: RemindTarget; text: string; remindAt: string; to: string }
  | { do: 'status'; emoji: string | null; text: string }
  | { do: 'status-clear' }
  /** `minutes: null` ends a pause or a hand-set Do not disturb. */
  | { do: 'dnd'; minutes: number | null }
  | { do: 'away' }
  | { do: 'invite'; personId: string; name: string }
  | { do: 'leave' }
  /** `on: false` lets the conversation follow the default level again. */
  | { do: 'mute'; on: boolean }
  | { do: 'topic'; text: string }
  /** Nothing is sent and the text stays in the box; the sentence says what to fix. */
  | { do: 'say'; message: string };

/** The plans that change something through a route of another plugin instead of posting a message (carried out by `runSlashAction`). */
export type ActionPlan = Extract<SlashPlan, { do: 'remind' | 'status' | 'status-clear' | 'dnd' | 'away' | 'invite' | 'leave' | 'mute' | 'topic' }>;
export const isActionPlan = (plan: SlashPlan): plan is ActionPlan =>
  ['remind', 'status', 'status-clear', 'dnd', 'away', 'invite', 'leave', 'mute', 'topic'].includes(plan.do);

export const TITLE_MAX = 200;
const MAX_NAMED = 5;

/** `/shrug` as it is stored: the backslash and underscores are escaped so the message renderer draws the whole face. */
export const SHRUG = '¯\\\\\\_(ツ)\\_/¯';

function botByWord(word: string, bots: readonly SlashBot[]): SlashBot | undefined {
  const w = word.replace(/^@/, '').toLowerCase();
  return bots.find((b) => b.slug.toLowerCase() === w) ?? bots.find((b) => b.name.toLowerCase().replace(/\s+/g, '-') === w);
}

export const unknownCommandText = (name: string): string =>
  `There is no command called /${name}. Type /help to see the commands. To post it as text, start the message with two slashes: //${name}.`;

/** Finds the person a `@word` means on the team's roster: by their handle, or by their full name with hyphens for spaces. */
export function findPerson(word: string, people: readonly SlashPerson[]): SlashPerson | 'unknown' | 'ambiguous' {
  const w = word.replace(/^@/, '').toLowerCase();
  const hits = people.filter((p) => p.handle.toLowerCase() === w || p.name.toLowerCase().replace(/\s+/g, '-') === w);
  if (hits.length === 1) return hits[0]!;
  return hits.length === 0 ? 'unknown' : 'ambiguous';
}

const say = (message: string): SlashPlan => ({ do: 'say', message });

/** `/remind`: who, when and what, worked out against the page's clock and zone; the server checks the moment again. */
function planRemind(args: string, who: SlashWho, env: SlashEnv): SlashPlan {
  const r = parseRemindArgs(args, env.now, env.timeZone);
  if (r.kind === 'list') return { do: 'remind-list' };
  if (r.kind === 'error') return say(r.reason);
  const remindAt = r.at.toISOString();
  if (r.who.kind === 'me') return { do: 'remind', target: { kind: 'me' }, text: r.text, remindAt, to: 'you' };
  if (r.who.kind === 'channel') {
    const name = r.who.name.toLowerCase();
    const channel = env.channels.find((c) => c.name.replace(/^#/, '').toLowerCase() === name);
    if (!channel) return say(`There is no channel called #${r.who.name} here that you can see.`);
    return { do: 'remind', target: { kind: 'channel', channelId: channel.id }, text: r.text, remindAt, to: `#${channel.name.replace(/^#/, '')}` };
  }
  if (!who.where) return say(WHERE_LOADING);
  const person = findPerson(r.who.name, env.people);
  if (person === 'unknown') return say(`I could not find @${r.who.name} on this team.`);
  if (person === 'ambiguous') return say(`More than one person is called @${r.who.name}. Use the handle the @ list shows.`);
  if (person.personId === env.selfPersonId) return say('To remind yourself, write /remind me instead of your own name.');
  // the person is reminded about this conversation: both of you must be able to read it (the server checks)
  return { do: 'remind', target: { kind: 'person', personId: person.personId, channelId: who.where.channelId }, text: r.text, remindAt, to: person.name };
}

/** Plans one message about to be sent: ordinary text is posted, a command is planned, and a `/word` that is no command is refused (never posted). `hasFiles`: files are attached to the message. */
export function planSlash(text: string, who: SlashWho, hasFiles = false, env: SlashEnv = defaultEnv()): SlashPlan {
  const parsed = parseSlash(text);
  if (parsed.kind === 'text') return { do: 'post', body: parsed.body };
  if (parsed.kind === 'unknown') return say(unknownCommandText(parsed.name));
  const { command, args } = parsed;
  const can = availability(command, who);
  if (!can.ok) return { do: 'say', message: can.reason };
  if (hasFiles && command.name !== 'shrug' && command.name !== 'me' && command.name !== 'ask') {
    return { do: 'say', message: `Remove the attached files first: /${command.name} does not post a message.` };
  }
  switch (command.name) {
    case 'remind':
      return planRemind(args, who, env);
    case 'status': {
      const a = parseStatusArgs(args);
      if (a.kind === 'error') return say(a.reason);
      return a.kind === 'clear' ? { do: 'status-clear' } : { do: 'status', emoji: a.emoji, text: a.text };
    }
    case 'dnd': {
      const a = parseDndArgs(args);
      if (a.kind === 'error') return say(a.reason);
      return { do: 'dnd', minutes: a.kind === 'off' ? null : a.minutes };
    }
    case 'away':
      return args === '' ? { do: 'away' } : say('Type /away on its own. To post this as a message, start it with two slashes: //away.');
    case 'invite': {
      const a = parseInviteArgs(args);
      if (a.kind === 'error') return say(a.reason);
      const person = findPerson(a.handle, env.people);
      if (person === 'unknown') return say(`I could not find @${a.handle} on this team.`);
      if (person === 'ambiguous') return say(`More than one person is called @${a.handle}. Use the handle the @ list shows.`);
      if (person.personId === env.selfPersonId) return say('You are already here.');
      return { do: 'invite', personId: person.personId, name: person.name };
    }
    case 'leave':
      return args === '' ? { do: 'leave' } : say('Type /leave on its own. To post this as a message, start it with two slashes: //leave.');
    case 'mute': {
      const a = parseMuteArgs(args);
      if (a.kind === 'error') return say(a.reason);
      if (!who.where) return say(WHERE_LOADING);
      return { do: 'mute', on: a.kind === 'mute' };
    }
    case 'topic': {
      const a = parseTopicArgs(args);
      if (a.kind === 'error') return say(a.reason);
      return { do: 'topic', text: a.text };
    }
    case 'help':
      // "/help me with this" is a sentence, not the command: keep it in the box rather than open a dialog and empty it
      if (args !== '') return { do: 'say', message: 'Type /help on its own to see the commands. To post this as a message, start it with two slashes: //help.' };
      return { do: 'help' };
    case 'poll': {
      const parsed = parsePollArgs(args);
      if (parsed.kind === 'empty') return { do: 'poll', question: null, options: [] };
      if (parsed.kind === 'partial') return { do: 'poll', question: null, options: [], prefill: { question: parsed.question, options: parsed.options } };
      if (parsed.kind === 'error') return { do: 'say', message: parsed.reason };
      return { do: 'poll', question: parsed.question, options: parsed.options };
    }
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
      // a command in the list that this page does not run: say so, never post it as text
      return say(`/${command.name} is not available here.`);
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
