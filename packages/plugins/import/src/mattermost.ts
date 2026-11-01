import { createHash } from 'node:crypto';
import { DEFAULT_LIMITS, type ArchiveLimits } from './limits.ts';
import { ArchiveError, note, type ArchiveChannel, type ArchiveMessage, type ArchivePerson, type ArchiveReader, type Notes } from './model.ts';
import { slackEmoji } from './slack.ts';
import { cleanEmail, cleanLabel, cleanMessageText, jsonDepth, splitLines } from './text.ts';

// Reads a Mattermost bulk export: JSON lines, one record per line, each `{"type": "...", "<type>": {...}}`. The records are `version`, `team`, `channel`,
// `user` (with the channels they are in), `post` (with its replies and reactions inside it), `direct_channel` and `direct_post`. The file may be bare
// or inside a zip with its attachments. A post has no id in the export, so a message's key is a hash of who wrote what, where and when.
//
// Names in a Mattermost export (a username, `team/channel`) are only unique inside one server, but the import tables are keyed by the key alone. So every key
// is prefixed with a short fingerprint of the archive's own server (`scopeOf`: the export format version and the first team record), which a later export of the
// same server repeats and another server does not.

const TYPE_OF_LINE = /^\s*\{\s*"type"\s*:\s*"([a-z_]+)"/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const FIRST_PLAUSIBLE_MS = Date.UTC(1995, 0, 1);

const keyOf = (...parts: (string | number)[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
/** A conversation's key: its (already prefixed) members, sorted; a long list is shortened to a hash so the key stays inside the table's limit. */
const directKeyOf = (memberKeys: readonly string[]): string => {
  const joined = [...new Set(memberKeys)].sort().join(',');
  return joined.length <= 300 ? `direct:${joined}` : `direct:${createHash('sha256').update(joined).digest('hex').slice(0, 48)}`;
};

/** Which server an export came from: the export format version and the first team record (its name and display name). Twelve hex characters. */
const scopeOf = (version: string, firstTeam: string): string => createHash('sha256').update(`${version}\u0000${firstTeam}`).digest('hex').slice(0, 12);

type Scanned = { people: ArchivePerson[]; channels: ArchiveChannel[]; usernames: Set<string>; bots: Set<string>; scope: string };

const personKey = (scope: string, username: string): string => `${scope}:${username}`;
const channelKey = (scope: string, team: string, name: string): string => `${scope}:${team}/${name}`;

export class MattermostReader implements ArchiveReader {
  readonly source = 'mattermost' as const;
  readonly notes: Notes = new Map();
  readonly #open: () => AsyncIterable<Uint8Array>;
  readonly #closeFn: () => Promise<void>;
  readonly #limits: ArchiveLimits;
  readonly #hasFile: (path: string) => boolean;
  readonly #now: () => number;
  #scanned: Scanned | null = null;

  constructor(
    open: () => AsyncIterable<Uint8Array>,
    close: () => Promise<void>,
    options: { limits?: ArchiveLimits; hasFile?: (path: string) => boolean; now?: () => number } = {},
  ) {
    this.#open = open;
    this.#closeFn = close;
    this.#limits = options.limits ?? DEFAULT_LIMITS;
    this.#hasFile = options.hasFile ?? (() => false);
    this.#now = options.now ?? Date.now;
  }

  /** Pass one: everything that is not a post (people, channels, who is in which private channel). */
  async #scan(): Promise<Scanned> {
    if (this.#scanned) return this.#scanned;
    const { maxPeople, maxChannels, maxMemberships } = this.#limits;
    const people = new Map<string, { name: string; email: string | null; isBot: boolean }>();
    const channels = new Map<string, { team: string; name: string; display: string; kind: 'public' | 'private'; purpose: string; members: Set<string> }>();
    const directs: string[][] = [];
    const memberships: { team: string; channel: string; user: string }[] = [];
    let version: string | null = null;
    let firstTeam: string | null = null;
    for await (const item of splitLines(this.#open(), this.#limits.maxLineBytes)) {
      if ('tooLong' in item) {
        note(this.notes, 'line_too_long');
        continue;
      }
      const type = TYPE_OF_LINE.exec(item.line.toString('latin1', 0, 80))?.[1];
      if (type === 'post' || type === 'direct_post') continue;
      const rec = this.#parse(item.line);
      if (rec === null) continue;
      const kind = asString(rec['type']);
      if (kind === 'version') {
        const v = rec['version'];
        if (version === null && (typeof v === 'string' || typeof v === 'number')) version = String(v).slice(0, 40);
      } else if (kind === 'team' && isRecord(rec['team'])) {
        if (firstTeam === null) firstTeam = `${cleanLabel(rec['team']['name'], 80)}\u0000${cleanLabel(rec['team']['display_name'], 80)}`;
      } else if (kind === 'user' && isRecord(rec['user'])) {
        const u = rec['user'];
        const username = cleanLabel(u['username'], 80);
        if (username === '') {
          note(this.notes, 'malformed_entry');
          continue;
        }
        const full = [cleanLabel(u['first_name'], 60), cleanLabel(u['last_name'], 60)].filter(Boolean).join(' ');
        people.set(username, { name: cleanLabel(u['nickname'], 120) || full || username, email: cleanEmail(u['email']), isBot: u['is_bot'] === true });
        if (people.size > maxPeople) throw new ArchiveError(`That Mattermost export lists more than ${maxPeople.toLocaleString('en-US')} people, which is more than an import can take.`);
        for (const t of Array.isArray(u['teams']) ? u['teams'].slice(0, 500) : []) {
          if (!isRecord(t)) continue;
          for (const c of Array.isArray(t['channels']) ? t['channels'].slice(0, 5_000) : []) {
            if (!isRecord(c)) continue;
            memberships.push({ team: asString(t['name']), channel: asString(c['name']), user: username });
            if (memberships.length > maxMemberships) {
              throw new ArchiveError(`That Mattermost export lists more than ${maxMemberships.toLocaleString('en-US')} channel memberships, which is more than an import can take.`);
            }
          }
        }
      } else if (kind === 'channel' && isRecord(rec['channel'])) {
        const c = rec['channel'];
        const team = cleanLabel(c['team'], 80);
        const name = cleanLabel(c['name'], 80);
        if (name === '') {
          note(this.notes, 'malformed_entry');
          continue;
        }
        channels.set(`${team}/${name}`, {
          team,
          name,
          display: cleanLabel(c['display_name'], 80) || name,
          kind: asString(c['type']) === 'P' ? 'private' : 'public',
          purpose: cleanLabel(c['purpose'] ?? c['header'], 500),
          members: new Set(),
        });
        if (channels.size + directs.length > maxChannels) throw new ArchiveError(`That Mattermost export lists more than ${maxChannels.toLocaleString('en-US')} channels, which is more than an import can take.`);
      } else if (kind === 'direct_channel' && isRecord(rec['direct_channel'])) {
        const members = Array.isArray(rec['direct_channel']['members']) ? rec['direct_channel']['members'].filter((m): m is string => typeof m === 'string' && m !== '').slice(0, 20) : [];
        if (members.length < 2) {
          note(this.notes, 'malformed_entry');
          continue;
        }
        directs.push(members);
        if (channels.size + directs.length > maxChannels) throw new ArchiveError(`That Mattermost export lists more than ${maxChannels.toLocaleString('en-US')} channels, which is more than an import can take.`);
      }
    }
    const scope = scopeOf(version ?? '', firstTeam ?? '');
    for (const m of memberships) channels.get(`${m.team}/${m.channel}`)?.members.add(m.user);
    const list: ArchiveChannel[] = [];
    for (const c of channels.values()) {
      const members = [...c.members].map((u) => personKey(scope, u));
      list.push({
        key: channelKey(scope, c.team, c.name),
        name: c.display,
        kind: c.kind,
        slug: c.name,
        purpose: c.purpose,
        memberKeys: c.kind === 'private' ? (members.length > 0 ? members : null) : null,
      });
    }
    const seenDirect = new Set<string>();
    for (const raw of directs) {
      const memberKeys = [...new Set(raw.map((u) => personKey(scope, u)))];
      const key = directKeyOf(memberKeys);
      if (seenDirect.has(key)) continue;
      seenDirect.add(key);
      list.push({ key, name: 'direct', kind: 'direct', purpose: '', memberKeys });
    }
    this.#scanned = {
      people: [...people].map(([username, p]) => ({ key: personKey(scope, username), name: p.name, email: p.email, isBot: p.isBot })),
      channels: list,
      usernames: new Set(people.keys()),
      bots: new Set([...people].filter(([, p]) => p.isBot).map(([username]) => username)),
      scope,
    };
    return this.#scanned;
  }

  #parse(line: Buffer): Record<string, unknown> | null {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
      if (jsonDepth(text) > this.#limits.maxJsonDepth) {
        note(this.notes, 'malformed_entry');
        return null;
      }
      const v: unknown = JSON.parse(text);
      if (!isRecord(v)) throw new Error('not an object');
      return v;
    } catch {
      note(this.notes, 'malformed_entry');
      return null;
    }
  }

  nameOf(key: string): string {
    const i = key.indexOf(':');
    return i < 0 ? key : key.slice(i + 1);
  }

  async people(): Promise<ArchivePerson[]> {
    return (await this.#scan()).people;
  }

  async channels(): Promise<ArchiveChannel[]> {
    return (await this.#scan()).channels;
  }

  async *messages(include?: (channelKey: string) => boolean): AsyncGenerator<ArchiveMessage> {
    const { usernames, bots, scope } = await this.#scan();
    for await (const item of splitLines(this.#open(), this.#limits.maxLineBytes)) {
      if ('tooLong' in item) continue;
      const type = TYPE_OF_LINE.exec(item.line.toString('latin1', 0, 80))?.[1];
      if (type !== 'post' && type !== 'direct_post') continue;
      const rec = this.#parse(item.line);
      if (rec === null) continue;
      const body = rec[type];
      if (!isRecord(body)) {
        note(this.notes, 'malformed_entry');
        continue;
      }
      const key =
        type === 'post'
          ? channelKey(scope, cleanLabel(body['team'], 80), cleanLabel(body['channel'], 80))
          : Array.isArray(body['channel_members'])
            ? directKeyOf(body['channel_members'].filter((m): m is string => typeof m === 'string').map((u) => personKey(scope, u)))
            : '';
      if (key === '' || (include && !include(key))) continue;
      const root = this.#post(key, body, null, usernames, bots, scope);
      if (root === null) continue;
      const replies = Array.isArray(body['replies']) ? body['replies'].slice(0, 100_000) : [];
      const built: ArchiveMessage[] = [];
      for (const r of replies) {
        if (!isRecord(r)) {
          note(this.notes, 'malformed_entry');
          continue;
        }
        const m = this.#post(key, r, root.key, usernames, bots, scope);
        if (m) built.push(m);
      }
      built.sort((a, b) => a.at - b.at);
      // the flag is set before the root is handed on: the importer counts a thread when it sees its first message, which may be the last one of a batch
      root.startsThread = built.length > 0;
      yield root;
      for (const m of built) yield m;
    }
  }

  #post(channel: string, p: Record<string, unknown>, rootKey: string | null, usernames: Set<string>, bots: Set<string>, scope: string): ArchiveMessage | null {
    // The key is made from the time the archive says; only the time that is stored is put back to now, or a message dated in the future would get a new key on every run.
    const written = typeof p['create_at'] === 'number' && Number.isFinite(p['create_at']) ? Math.trunc(p['create_at']) : NaN;
    const at = Math.min(written, this.#now());
    const user = cleanLabel(p['user'], 80);
    if (!(written >= FIRST_PLAUSIBLE_MS) || user === '') {
      note(this.notes, 'malformed_entry');
      return null;
    }
    const raw = asString(p['message']);
    const cleaned = cleanMessageText(raw);
    const files: ArchiveMessage['files'] = [];
    for (const a of (Array.isArray(p['attachments']) ? p['attachments'] : []).slice(0, 100)) {
      if (!isRecord(a)) continue;
      const path = asString(a['path']);
      files.push({ name: cleanLabel(path.split('/').pop(), 120) || 'a file', inArchive: path !== '' && this.#hasFile(path) });
    }
    const key = rootKey === null ? keyOf(channel, user, written, raw) : keyOf(rootKey, user, written, raw);
    const base = { channelKey: channel, key, at, authorKey: personKey(scope, user), rootKey, startsThread: false };
    // an account marked as a bot is an app, as in Slack: its posts are left out and counted, not written under a made-up person
    if (bots.has(user)) return { ...base, text: '', reactions: [], files: [], skip: 'app_message', mentions: 0, shortened: false };
    if (cleaned.text === '' && files.length === 0) return { ...base, text: '', reactions: [], files: [], skip: 'empty_message', mentions: 0, shortened: false };
    const byEmoji = new Map<string, string[]>();
    for (const r of (Array.isArray(p['reactions']) ? p['reactions'] : []).slice(0, 2_000)) {
      if (!isRecord(r)) continue;
      const emoji = slackEmoji(cleanLabel(r['emoji_name'], 60));
      const who = cleanLabel(r['user'], 80);
      if (emoji === null || who === '') continue;
      const list = byEmoji.get(emoji) ?? [];
      list.push(personKey(scope, who));
      byEmoji.set(emoji, list);
    }
    let mentions = 0;
    for (const m of cleaned.text.matchAll(/(^|\s)@([a-z0-9._-]{1,60})/gi)) if (usernames.has(m[2]!)) mentions += 1;
    return {
      ...base,
      text: cleaned.text,
      reactions: [...byEmoji].map(([emoji, userKeys]) => ({ emoji, userKeys })),
      files,
      skip: null,
      mentions,
      shortened: cleaned.shortened,
    };
  }

  async close(): Promise<void> {
    await this.#closeFn();
  }
}
