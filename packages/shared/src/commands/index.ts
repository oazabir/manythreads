/*
 * Slash commands typed in a message box (PLAN P14-06): the list of commands, how a message is read as a command, and what the menu offers
 * while a command is being typed. Pure text rules with no browser or server in them, so the web client, the tests and a later server check
 * read a message the same way. Running a command is the client's job (it posts a message or asks an existing route); the server stays the
 * authority on what a person may do.
 *
 * A message is a command only when its very first character is `/` and the word after it names a command in the list. Anything else that
 * starts with a slash (`/etc/hosts`, `/xyz`, a pasted path) is an ordinary message and is posted as typed. To start a message with a command
 * word as plain text, type two slashes: `//ask` posts `/ask`.
 */

/** What a command needs from the person's side: nothing, or being a member of the team the conversation belongs to. */
export type SlashNeeds = 'anyone' | 'team_member';

/** Whether the command takes words after its name. */
export type SlashArgs = 'none' | 'optional' | 'required';

export type SlashCommand = {
  /** Lowercase, what the person types after the slash. */
  name: string;
  /** How the command is written, with its words in angle brackets. */
  usage: string;
  /** One plain sentence for the menu and the help list. */
  summary: string;
  args: SlashArgs;
  needs: SlashNeeds;
  /** The first word after the command names one of the team's bots: the menu offers the bots there. */
  firstWordIsBot?: boolean;
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'ask', usage: '/ask <bot> <question>', summary: 'Ask one of the team’s bots a question. It answers in this conversation.', args: 'required', needs: 'team_member', firstWordIsBot: true },
  { name: 'task', usage: '/task <title>', summary: 'Create a card on the team’s board, from this conversation.', args: 'required', needs: 'team_member' },
  { name: 'me', usage: '/me <what you are doing>', summary: 'Post a line about yourself, like “Omar is at lunch”.', args: 'required', needs: 'anyone' },
  { name: 'shrug', usage: '/shrug [message]', summary: 'Add ¯\\_(ツ)_/¯ to your message.', args: 'optional', needs: 'anyone' },
  { name: 'help', usage: '/help', summary: 'Show the list of commands.', args: 'none', needs: 'anyone' },
];

export function findSlashCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase();
  return SLASH_COMMANDS.find((c) => c.name === n);
}

export type SlashParse =
  /** Post `body` as an ordinary message (an unknown `/word`, a path, or a `//` escape that lost one slash). */
  | { kind: 'text'; body: string }
  | { kind: 'command'; command: SlashCommand; args: string };

// the word right after the leading slash, ended by a space, a line break or the end of the text
const NAME = /^\/([A-Za-z][A-Za-z0-9_-]{0,31})(?=\s|$)/;
// `//` followed by a letter: the escape. `// a comment` and `//` alone are ordinary text and keep both slashes.
const ESCAPED = /^\/\/[A-Za-z]/;

/** Reads a message as it is about to be sent. Linear time: one anchored match and one lookup. */
export function parseSlash(text: string): SlashParse {
  if (ESCAPED.test(text)) return { kind: 'text', body: text.slice(1).trim() };
  const m = NAME.exec(text);
  if (!m) return { kind: 'text', body: text.trim() };
  const command = findSlashCommand(m[1] ?? '');
  if (!command) return { kind: 'text', body: text.trim() };
  return { kind: 'command', command, args: text.slice(m[0].length).trim() };
}

/** The commands whose name starts with what was typed after the slash, in list order. */
export function matchSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

export type SlashMenuContext =
  /** The command word is being typed: `from`..`to` is the word with its slash, to be replaced by the chosen command. */
  | { stage: 'command'; query: string; to: number }
  /** The first word after a command that names a bot is being typed: `from`..`to` is that word. */
  | { stage: 'bot'; command: SlashCommand; query: string; from: number; to: number };

const WORD_CHAR = /[A-Za-z0-9_.@-]/;

/**
 * What the menu should offer with the caret at `caret`, or null. It opens only at the very start of a message, on the first line, and only
 * while the first word is being typed (or, for a command that takes a bot, the word after it): never in the middle of a message, never on a
 * later line, so it cannot open inside a code block or a quoted paragraph.
 */
export function slashMenuContext(text: string, caret: number): SlashMenuContext | null {
  if (!text.startsWith('/') || text.startsWith('//')) return null;
  const firstLineEnd = text.indexOf('\n') === -1 ? text.length : text.indexOf('\n');
  if (caret > firstLineEnd || caret < 1) return null;
  let wordEnd = 1;
  while (wordEnd < firstLineEnd && /[A-Za-z0-9_-]/.test(text[wordEnd] ?? '')) wordEnd += 1;
  if (caret <= wordEnd) return { stage: 'command', query: text.slice(1, caret), to: wordEnd };
  // after the command word: only a command that names a bot, and only the single word right after it
  const command = findSlashCommand(text.slice(1, wordEnd));
  if (!command?.firstWordIsBot || text[wordEnd] !== ' ') return null;
  let from = wordEnd;
  while (from < firstLineEnd && text[from] === ' ') from += 1;
  if (caret < from) return null;
  let to = from;
  while (to < firstLineEnd && WORD_CHAR.test(text[to] ?? '')) to += 1;
  if (caret > to) return null;
  return { stage: 'bot', command, query: text.slice(from, caret).replace(/^@/, ''), from, to };
}
