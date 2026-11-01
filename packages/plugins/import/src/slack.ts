import { NotTextError, cleanEmail, cleanLabel, cleanMessageText, decodeText, handleOf, splitJsonArray } from './text.ts';
import { DEFAULT_LIMITS, type ArchiveLimits } from './limits.ts';
import { note, type ArchiveChannel, type ArchiveMessage, type ArchivePerson, type ArchiveReader, type Notes } from './model.ts';
import { ZipRefused, type ZipArchive, type ZipEntry } from './zip.ts';

// Reads a Slack export zip (Workspace settings, Import/Export data). Its layout:
//   users.json  channels.json  groups.json  mpims.json  dms.json      the people, public channels, private channels, group and direct conversations
//   <channel name>/YYYY-MM-DD.json                                      one file per channel and day, an array of messages
// A direct conversation's folder is named by its id. Files named in a message are links to Slack's servers: this reader never follows them.

/** Subtypes that are real writing. Every other subtype (joins, leaves, renames, pins, reminders) is a notice, not a message. */
const WRITING_SUBTYPES = new Set(['thread_broadcast', 'reply_broadcast', 'file_share', 'me_message']);
const HUDDLE_SUBTYPES = new Set(['huddle_thread', 'room']);
const SLACK_TS = /^\d{9,11}(\.\d{1,6})?$/;
const FIRST_PLAUSIBLE_MS = Date.UTC(1995, 0, 1);
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/** Common Slack emoji names as the characters they stand for. A name not here stays as `:name:` text. */
const EMOJI: Record<string, string> = {
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', heart: '❤️', smile: '😄', smiley: '😃', grinning: '😀', laughing: '😆', joy: '😂', rofl: '🤣',
  wink: '😉', blush: '😊', slightly_smiling_face: '🙂', upside_down_face: '🙃', thinking_face: '🤔', neutral_face: '😐', confused: '😕', cry: '😢', sob: '😭',
  scream: '😱', rage: '😡', angry: '😠', sunglasses: '😎', heart_eyes: '😍', kissing_heart: '😘', pray: '🙏', clap: '👏', raised_hands: '🙌', wave: '👋',
  ok_hand: '👌', muscle: '💪', point_up: '☝️', eyes: '👀', fire: '🔥', tada: '🎉', sparkles: '✨', star: '⭐', rocket: '🚀', white_check_mark: '✅',
  heavy_check_mark: '✔️', x: '❌', warning: '⚠️', question: '❓', exclamation: '❗', bulb: '💡', 100: '💯', zap: '⚡', boom: '💥', bug: '🐛', lock: '🔒',
  memo: '📝', book: '📖', calendar: '📅', coffee: '☕', pizza: '🍕', beer: '🍺', trophy: '🏆', gift: '🎁', balloon: '🎈', sunny: '☀️', rainbow: '🌈',
  see_no_evil: '🙈', facepalm: '🤦', shrug: '🤷', raising_hand: '🙋', handshake: '🤝', hourglass: '⌛', mag: '🔍', link: '🔗', bell: '🔔', construction: '🚧',
  'heavy_plus_sign': '➕', 'heavy_minus_sign': '➖', arrow_up: '⬆️', arrow_down: '⬇️', checkered_flag: '🏁', skull: '💀', ghost: '👻', robot_face: '🤖', cat: '🐱', dog: '🐶',
};

/** A reaction name from Slack (`+1`, `thumbsup::skin-tone-3`) as the emoji the platform shows. */
export function slackEmoji(name: string): string | null {
  const base = name.split('::')[0]!.trim().toLowerCase();
  if (base === '' || base.length > 60 || /\s/.test(base)) return null;
  return EMOJI[base] ?? `:${base}:`;
}

const UNSAFE_URL = /[\s<>"`\\]/;
const safeUrl = (url: string): string | null => (/^(https?:\/\/|mailto:)/i.test(url) && !UNSAFE_URL.test(url) && url.length <= 2000 ? url : null);
const labelSafe = (label: string): string => label.replace(/\\/g, '\\\\').replace(/\]/g, '\\]').replace(/\[/g, '\\[');
const urlSafe = (url: string): string => url.replace(/\(/g, '%28').replace(/\)/g, '%29');

/**
 * Slack's own markup as the platform's plain text: `<@U1>` is `@ada`, `<#C1|general>` is `#general`, `<!here>` is `@here`, `<https://x|label>` is a
 * link and `&amp;` is `&`. Mentions become plain text on purpose: an old message must not notify anybody. Returns how many mentions it turned.
 */
export function convertSlackText(
  raw: string,
  nameOf: (userKey: string) => string | null,
  channelNameOf: (channelKey: string) => string | null,
): { text: string; mentions: number } {
  let mentions = 0;
  const out = raw.replace(/<([^<>\n]{1,2100})>/g, (_all, inner: string) => {
    const bar = inner.indexOf('|');
    const target = bar < 0 ? inner : inner.slice(0, bar);
    const label = bar < 0 ? '' : inner.slice(bar + 1);
    if (target.startsWith('@')) {
      mentions += 1;
      const known = nameOf(target.slice(1));
      return `@${handleOf(known ?? (label || 'someone'))}`;
    }
    if (target.startsWith('#')) {
      const known = channelNameOf(target.slice(1)) ?? label;
      return known ? `#${known}` : '#channel';
    }
    if (target.startsWith('!')) {
      const word = target.slice(1);
      if (word === 'here' || word === 'channel' || word === 'everyone') return `@${word}`;
      if (word.startsWith('subteam^')) return label ? (label.startsWith('@') ? label : `@${label}`) : '@group';
      if (word.startsWith('date')) return label || '';
      return label || '';
    }
    const url = safeUrl(target);
    if (url === null) return label || '';
    return label && label !== url ? `[${labelSafe(label)}](${urlSafe(url)})` : url;
  });
  return { text: out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), mentions };
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stringList = (v: unknown, max = 100_000): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80).slice(0, max) : []);

export class SlackReader implements ArchiveReader {
  readonly source = 'slack' as const;
  readonly notes: Notes = new Map();
  readonly #zip: ZipArchive;
  readonly #limits: ArchiveLimits;
  readonly #prefix: string;
  readonly #names = new Map<string, string>();
  readonly #channelNames = new Map<string, string>();
  readonly #bots = new Set<string>();
  readonly #upload: Set<string>;
  #people: ArchivePerson[] | null = null;
  #channels: ArchiveChannel[] | null = null;
  readonly #dirs = new Map<string, string[]>();
  readonly #now: () => number;

  constructor(zip: ZipArchive, limits: ArchiveLimits = DEFAULT_LIMITS, now: () => number = Date.now) {
    this.#zip = zip;
    this.#limits = limits;
    this.#now = now;
    this.#prefix = detectPrefix(zip);
    this.#upload = new Set(
      zip.entries.filter((e) => e.name.startsWith(`${this.#prefix}__uploads/`)).map((e) => e.name.slice(`${this.#prefix}__uploads/`.length).split('/')[0]!),
    );
    if (zip.refused.length > 0) note(this.notes, 'refused_entry', zip.refused.length);
  }

  async #array(name: string): Promise<unknown[]> {
    const entry = this.#zip.find(`${this.#prefix}${name}`);
    if (!entry) return [];
    const out: unknown[] = [];
    try {
      const text = decodeText(await this.#zip.read(entry));
      for (const piece of splitJsonArray(text, this.#limits.maxJsonDepth)) {
        if (piece.ok) out.push(piece.value);
        else note(this.notes, 'malformed_entry');
      }
    } catch (err) {
      note(this.notes, err instanceof ZipRefused ? 'refused_entry' : 'malformed_entry');
    }
    return out;
  }

  async people(): Promise<ArchivePerson[]> {
    if (this.#people) return this.#people;
    const people: ArchivePerson[] = [];
    for (const raw of await this.#array('users.json')) {
      if (!isRecord(raw)) {
        note(this.notes, 'malformed_entry');
        continue;
      }
      const key = asString(raw['id']);
      if (key === '' || key.length > 80) {
        note(this.notes, 'malformed_entry');
        continue;
      }
      const profile = isRecord(raw['profile']) ? raw['profile'] : {};
      const name =
        cleanLabel(profile['real_name'] ?? raw['real_name'], 120) || cleanLabel(profile['display_name'], 120) || cleanLabel(raw['name'], 120) || key;
      const isBot = raw['is_bot'] === true || raw['is_app_user'] === true || key === 'USLACKBOT';
      people.push({ key, name, email: cleanEmail(profile['email']), isBot });
      this.#names.set(key, name);
      if (isBot) this.#bots.add(key);
    }
    this.#people = people;
    return people;
  }

  async channels(): Promise<ArchiveChannel[]> {
    if (this.#channels) return this.#channels;
    await this.people();
    const out: ArchiveChannel[] = [];
    const add = (raw: unknown, kind: 'public' | 'private' | 'direct'): void => {
      if (!isRecord(raw)) {
        note(this.notes, 'malformed_entry');
        return;
      }
      const key = asString(raw['id']);
      if (key === '' || key.length > 80) {
        note(this.notes, 'malformed_entry');
        return;
      }
      const name = cleanLabel(raw['name'], 80);
      const members = Array.isArray(raw['members']) ? stringList(raw['members']) : null;
      const purpose = cleanLabel(isRecord(raw['purpose']) ? raw['purpose']['value'] : '', 500);
      const dirs = [name, key].filter((d) => d !== '');
      out.push({ key, name: name || key, kind, slug: key, purpose, memberKeys: kind === 'public' ? null : members });
      this.#dirs.set(key, dirs);
      if (kind !== 'direct') this.#channelNames.set(key, name || key);
    };
    for (const raw of await this.#array('channels.json')) add(raw, 'public');
    for (const raw of await this.#array('groups.json')) add(raw, 'private');
    for (const raw of await this.#array('mpims.json')) add(raw, 'direct');
    for (const raw of await this.#array('dms.json')) add(raw, 'direct');
    this.#channels = out;
    return out;
  }

  async *messages(include?: (channelKey: string) => boolean): AsyncGenerator<ArchiveMessage> {
    const channels = await this.channels();
    // folder → its day files, oldest day first
    const folders = new Map<string, { day: string; entry: ZipEntry }[]>();
    for (const entry of this.#zip.entries) {
      if (!entry.name.startsWith(this.#prefix)) continue;
      const rest = entry.name.slice(this.#prefix.length).split('/');
      if (rest.length !== 2) continue;
      const m = DAY_FILE.exec(rest[1]!);
      if (!m) continue;
      const list = folders.get(rest[0]!) ?? [];
      list.push({ day: m[1]!, entry });
      folders.set(rest[0]!, list);
    }
    for (const list of folders.values()) list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const used = new Set<string>();
    for (const channel of channels) {
      if (include && !include(channel.key)) continue;
      const dir = (this.#dirs.get(channel.key) ?? []).find((d) => folders.has(d) && !used.has(d));
      if (dir === undefined) continue;
      used.add(dir);
      for (const { entry } of folders.get(dir)!) {
        let pieces: ArchiveMessage[];
        try {
          pieces = this.#dayFile(channel, decodeText(await this.#zip.read(entry)));
        } catch (err) {
          note(this.notes, err instanceof ZipRefused ? 'refused_entry' : 'malformed_entry');
          continue;
        }
        for (const m of pieces) yield m;
      }
    }
  }

  #dayFile(channel: ArchiveChannel, text: string): ArchiveMessage[] {
    const out: ArchiveMessage[] = [];
    try {
      for (const piece of splitJsonArray(text, this.#limits.maxJsonDepth)) {
        if (!piece.ok) {
          note(this.notes, 'malformed_entry');
          continue;
        }
        const m = this.#message(channel, piece.value);
        if (m) out.push(m);
      }
    } catch (err) {
      if (err instanceof NotTextError) note(this.notes, 'malformed_entry');
      else throw err;
    }
    return out.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
  }

  #message(channel: ArchiveChannel, raw: unknown): ArchiveMessage | null {
    if (!isRecord(raw)) {
      note(this.notes, 'malformed_entry');
      return null;
    }
    const ts = asString(raw['ts']);
    if (!SLACK_TS.test(ts)) {
      note(this.notes, 'malformed_entry');
      return null;
    }
    const at = Math.min(Math.floor(Number(ts) * 1000), this.#now());
    if (at < FIRST_PLAUSIBLE_MS) {
      note(this.notes, 'malformed_entry');
      return null;
    }
    const threadTs = asString(raw['thread_ts']);
    const reply = SLACK_TS.test(threadTs) && threadTs !== ts;
    const authorKey = asString(raw['user']) || null;
    const base: Omit<ArchiveMessage, 'skip' | 'text' | 'mentions' | 'shortened' | 'files' | 'reactions'> = {
      channelKey: channel.key,
      key: `${channel.key}:${ts}`,
      at,
      authorKey,
      rootKey: reply ? `${channel.key}:${threadTs}` : null,
      startsThread: SLACK_TS.test(threadTs) && threadTs === ts,
    };
    const left = (skip: ArchiveMessage['skip']): ArchiveMessage => ({ ...base, text: '', mentions: 0, shortened: false, files: [], reactions: [], skip });
    const subtype = asString(raw['subtype']);
    if (HUDDLE_SUBTYPES.has(subtype) || isRecord(raw['room'])) return left('huddle');
    if (raw['bot_id'] || raw['app_id'] || subtype === 'bot_message' || (authorKey !== null && this.#bots.has(authorKey))) return left('app_message');
    if (subtype !== '' && !WRITING_SUBTYPES.has(subtype)) return left('system_message');
    const converted = convertSlackText(
      asString(raw['text']),
      (k) => this.#names.get(k) ?? null,
      (k) => this.#channelNames.get(k) ?? null,
    );
    const cleaned = cleanMessageText(converted.text);
    const files: ArchiveMessage['files'] = [];
    let canvases = 0;
    if (Array.isArray(raw['files'])) {
      for (const f of raw['files'].slice(0, 100)) {
        if (!isRecord(f)) continue;
        if (asString(f['filetype']) === 'canvas' || asString(f['filetype']) === 'quip') {
          canvases += 1;
          continue;
        }
        files.push({ name: cleanLabel(f['name'] ?? f['title'], 120) || 'a file', inArchive: this.#upload.has(asString(f['id'])) });
      }
    }
    for (let i = 0; i < canvases; i += 1) note(this.notes, 'canvas');
    if (cleaned.text === '' && files.length === 0) return canvases > 0 ? null : left('empty_message');
    const reactions: ArchiveMessage['reactions'] = [];
    if (Array.isArray(raw['reactions'])) {
      for (const r of raw['reactions'].slice(0, 200)) {
        if (!isRecord(r)) continue;
        const emoji = slackEmoji(asString(r['name']));
        if (emoji === null) continue;
        reactions.push({ emoji, userKeys: stringList(r['users'], 5_000) });
      }
    }
    return { ...base, text: cleaned.text, mentions: converted.mentions, shortened: cleaned.shortened, files, reactions, skip: null };
  }

  async close(): Promise<void> {
    await this.#zip.close();
  }
}

/** Slack exports have no top folder, but a zip made by hand from the export's folder often does: find where `users.json` or `channels.json` sits. */
function detectPrefix(zip: ZipArchive): string {
  for (const marker of ['channels.json', 'users.json']) {
    if (zip.find(marker)) return '';
    const hit = zip.entries.find((e) => e.name.endsWith(`/${marker}`) && e.name.split('/').length === 2);
    if (hit) return hit.name.slice(0, hit.name.length - marker.length);
  }
  return '';
}
