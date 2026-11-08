import type { InboundMessage } from '../adapter.ts';

// How people type a command to the bridge in Slack and Teams (PLAN Bundle D, P16-09). Slack swallows a message that starts with `/` (it is a slash command there), so in both services a command is
// the plain word: `connect 12345678`, `start 12345678`, `unlink`, `bot`. A slash or a bang in front is accepted too (`!bot Brain`), and picking a bot by name needs one of them because
// "bot status" is ordinary talk. Only forms that cannot be ordinary talk are read bare: a word followed by a code, and the single words `unlink` and `bot` in a private chat.

const PREFIXED = /^[/!](start|connect|unlink|bot)(?:[ \t]+([\s\S]*))?$/i;
const BARE = /^(?:(start|connect)[ \t]+([0-9][0-9 -]{6,12}[0-9])|(unlink|bot))$/i;

export function textCommand(text: string, kind: 'private' | 'group'): InboundMessage['command'] {
  const body = text.trim();
  const p = PREFIXED.exec(body);
  if (p) return { name: p[1]!.toLowerCase() as 'start' | 'connect' | 'unlink' | 'bot', argument: (p[2] ?? '').trim() };
  const b = BARE.exec(body);
  if (!b) return null;
  if (b[3] !== undefined) return kind === 'private' ? { name: b[3].toLowerCase() as 'unlink' | 'bot', argument: '' } : null;
  return { name: b[1]!.toLowerCase() as 'start' | 'connect', argument: b[2]!.trim() };
}
