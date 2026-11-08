// Plain words for the internal names the grader works with (found live on P7-04: a person read "messages.post" and "channel_message" in a reason). The person sees these labels; the names stay
// inside the code. A name the table does not know is spelled out (dots, underscores and hyphens become spaces), never shown as an id.

const TOOLS: Record<string, string> = {
  'messages.post': 'post messages',
  'messages.search': 'search messages',
  'answer.post': 'post an answer',
  'surface.render': 'draw screens',
  'surface.update': 'change screens it drew',
  'surface.event': 'read what people pressed on its screens',
  'knowledge.search': 'search the team knowledge',
  'memory.recall': 'remember things it was told',
  'memory.write': 'save notes to memory',
  'inbox.read': 'read the item it is filing',
  'meetings.read': 'read the transcript of a meeting',
  'meetings.write_notes': 'write the notes of a meeting',
  'inbox.drop': 'drop notes into the team inbox',
  'pages.write': 'write pages',
  'pages.read': 'read pages',
  'files.write': 'change files',
  'files.read': 'read files',
  'tasks.create': 'create tasks',
  'tasks.own': 'work on its own tasks',
  'proposals.propose': 'propose changes for approval',
  'email.send': 'send email',
};

const TRIGGERS: Record<string, string> = {
  conversation: 'someone talks to it directly',
  mention: 'someone mentions it',
  channel_message: 'a new message appears in a channel',
  task_assigned: 'a task is given to it',
  routine: 'a set time or schedule comes',
  inbox: 'an email arrives',
  drop: 'something is dropped into the team inbox',
  webhook: 'another app calls it',
};

const RUNTIMES: Record<string, string> = { shell: 'a shell (it runs commands)', files: 'files on a work disk', browser: 'a web browser' };

const spelled = (name: string): string => name.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** What a tool lets the bot do, as a short verb phrase ("post messages"). */
export const plainTool = (name: string): string => TOOLS[name] ?? spelled(name);
/** When a trigger starts the bot ("a new message appears in a channel"). */
export const plainTrigger = (name: string): string => TRIGGERS[name] ?? spelled(name);
export const plainRuntime = (name: string): string => RUNTIMES[name] ?? spelled(name);
/** A model alias as a person would say it. */
export const plainAlias = (alias: string): string => `${spelled(alias)} model`;

/** Replaces the internal names a text may carry (tool names, trigger names) with their plain labels. */
export function plainify(text: string): string {
  let out = text;
  for (const [name, label] of Object.entries(TOOLS)) out = out.split(name).join(label);
  for (const [name, label] of Object.entries(TRIGGERS)) out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), label);
  return out;
}

/** True when a text a person reads still holds something that looks like an internal id: a snake_case word, a hyphenated id of three or more parts (`no-write-access`), or a tool name. */
export function looksInternal(text: string): boolean {
  return /\b[a-z]+_[a-z_]+\b/.test(text) || /\b[a-z0-9]+(-[a-z0-9]+){2,}\b/.test(text) || /\b(?:messages|answer|knowledge|memory|pages|files|tasks|proposals|email)\.[a-z]+\b/.test(text);
}
