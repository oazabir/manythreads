import type { DirectMessageSummary, NavChannelGroup, SearchFileHit } from '@manythreads/shared';
import { GUEST_SLUG } from '../shell/messageLink';

/**
 * True when the press is the switcher's: Ctrl held (Cmd on a Mac) with the letter k. With Caps Lock on the browser reports `K`, so the
 * letter is compared without its case; Shift and Alt change the meaning (browser consoles, other tools) and are left alone.
 */
export const isQuickSwitcherKey = (e: { ctrlKey: boolean; metaKey: boolean; key: string; shiftKey?: boolean; altKey?: boolean }): boolean =>
  (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k';

export type SwitcherChannel = { id: string; name: string; isPrivate: boolean };

/** The directory's groups as one flat list, groups and their channels kept in sidebar order. */
export const flatChannels = (groups: readonly NavChannelGroup[]): SwitcherChannel[] =>
  groups.flatMap((g) => g.channels.map(({ id, name, isPrivate }) => ({ id, name, isPrivate })));

/** The channels whose name carries the query (case-insensitive, a leading `#` optional); an empty query is every channel. */
export const filterChannels = (list: readonly SwitcherChannel[], query: string): SwitcherChannel[] => {
  const q = query.trim().replace(/^#/, '').toLowerCase();
  if (!q) return [...list];
  return list.filter((c) => c.name.replace(/^#/, '').toLowerCase().includes(q));
};

/** The row ArrowUp/ArrowDown moves to, clamped at the ends; -1 means none, and any other key keeps the row. */
export const nextIndex = (count: number, current: number, key: string): number => {
  if (count < 1) return -1;
  if (key === 'ArrowDown') return current < 0 ? 0 : Math.min(count - 1, current + 1);
  if (key === 'ArrowUp') return current < 0 ? count - 1 : Math.max(0, current - 1);
  return current;
};

const TEXT_FIELD = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * Whether the focus sits somewhere the letter keys mean typing: a text field (input, textarea, select) or a rich editor. Read off the
 * element's own properties rather than `instanceof HTMLElement`, so the unit project (plain node, no DOM) can test it; the answers are
 * the same for every real element.
 */
export const typingIn = (el: EventTarget | null): boolean => {
  if (!el || typeof el !== 'object') return false;
  const { tagName, isContentEditable } = el as { tagName?: unknown; isContentEditable?: unknown };
  return isContentEditable === true || (typeof tagName === 'string' && TEXT_FIELD.test(tagName));
};

/** The team the switcher searches: the one in the URL (`/t/<team>/…`), else the guest's fixed slug, else the last team visited. */
export const switcherTeamSlug = (pathname: string, guest: boolean, lastTeam: string | null): string | null => {
  const m = /^\/t\/([a-z0-9][a-z0-9-]*)/.exec(pathname);
  return m?.[1] ?? (guest ? GUEST_SLUG : lastTeam);
};

/* ---- everything the switcher can jump to ---------------------------------------------------------------------------------------- */

export type SwitcherKind = 'channel' | 'dm' | 'person' | 'bot' | 'file' | 'page' | 'card' | 'section';

/** One row of the switcher. A row with a `to` opens that address; a person row (no `to`) opens or finds the conversation with them. */
export type SwitcherItem = { key: string; kind: SwitcherKind; label: string; hint: string; to: string | null; personId: string | null; isPrivate: boolean };

/** The order the kinds are listed in when nothing is typed, and the tie-break between equal fits. */
export const KIND_ORDER: readonly SwitcherKind[] = ['channel', 'dm', 'person', 'bot', 'section', 'page', 'card', 'file'];
export const KIND_LABEL: Readonly<Record<SwitcherKind, string>> = {
  channel: 'Channel',
  dm: 'Direct message',
  person: 'Person',
  bot: 'Bot',
  file: 'File',
  page: 'Page',
  card: 'Card',
  section: 'Go to',
};

const item = (i: Partial<SwitcherItem> & Pick<SwitcherItem, 'key' | 'kind' | 'label'>): SwitcherItem => ({ hint: KIND_LABEL[i.kind], to: null, personId: null, isPrivate: false, ...i });

const bare = (name: string): string => name.replace(/^#/, '');
const teamPath = (slug: string, rest: string): string => `/t/${encodeURIComponent(slug)}/${rest}`;

export const channelItems = (groups: readonly NavChannelGroup[], slug: string): SwitcherItem[] =>
  flatChannels(groups).map((c) => item({ key: `channel:${c.id}`, kind: 'channel', label: bare(c.name), to: `${teamPath(slug, 'c')}/${encodeURIComponent(bare(c.name))}`, isPrivate: c.isPrivate }));

/** Names of the other people in a conversation; a conversation with only yourself is "Notes to self". */
const dmName = (dm: DirectMessageSummary, selfPersonId: string): string => {
  const others = dm.participants.filter((p) => p.personId !== selfPersonId).map((p) => p.displayName);
  return others.length > 0 ? others.join(', ') : 'Notes to self';
};
export const dmItems = (dms: readonly DirectMessageSummary[], selfPersonId: string, slug: string): SwitcherItem[] =>
  dms.map((d) => item({ key: `dm:${d.channel.id}`, kind: 'dm', label: dmName(d, selfPersonId), to: teamPath(slug, `dm/${d.channel.id}`) }));

export const personItems = (members: readonly { personId: string; displayName: string }[], selfPersonId: string): SwitcherItem[] =>
  members.filter((m) => m.personId !== selfPersonId).map((m) => item({ key: `person:${m.personId}`, kind: 'person', label: m.displayName, hint: 'Person · message', personId: m.personId }));

export const botItems = (bots: readonly { id: string; slug: string; name: string; role: string }[], slug: string): SwitcherItem[] =>
  bots.map((b) => item({ key: `bot:${b.id}`, kind: 'bot', label: b.name, hint: b.role ? `Bot · ${b.role}` : 'Bot', to: teamPath(slug, `bots/${encodeURIComponent(b.slug)}`) }));

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['threads', 'Threads'],
  ['files', 'Files'],
  ['boards', 'Boards'],
  ['org', 'Org chart'],
  ['jobs', 'Jobs'],
  ['approvals', 'Approvals'],
  ['bots', 'Bots'],
];
/** The sidebar's own entries: Threads, Files, Boards and the rest of the team's screens (a guest has none of them). */
export const sectionItems = (slug: string, guest: boolean): SwitcherItem[] =>
  guest ? [] : SECTIONS.map(([path, label]) => item({ key: `section:${path}`, kind: 'section', label, to: teamPath(slug, path) }));

/** A board card: it opens on its own board, or the first one when it is on none. */
export const cardItems = (tasks: readonly { id: string; title: string; state: string; boardId: string | null }[], slug: string): SwitcherItem[] =>
  tasks.map((t) => {
    const q = new URLSearchParams();
    if (t.boardId) q.set('board', t.boardId);
    q.set('card', t.id);
    return item({ key: `card:${t.id}`, kind: 'card', label: t.title, hint: `Card · ${t.state.replace(/_/g, ' ')}`, to: `${teamPath(slug, 'boards')}?${q.toString()}` });
  });

/** Where a page sits, in words: its folder under `pages/`, or just "Page" at the top (the file path is not shown). */
const pageHint = (path: string): string => {
  const folders = path.split('/').slice(1, -1);
  return folders.length === 0 ? 'Page' : `Page · ${folders.join(' / ')}`;
};

/** The team's pages: the files directly under `pages/`. */
export const pageItems = (entries: readonly { name: string; path: string; kind: string }[], slug: string): SwitcherItem[] =>
  entries
    .filter((e) => e.kind === 'file')
    .map((e) => item({ key: `page:${e.path}`, kind: 'page', label: e.name.replace(/\.md$/i, ''), hint: pageHint(e.path), to: `${teamPath(slug, 'files')}?open=${encodeURIComponent(e.path)}` }));

/** Attachments found by the search; a file of another team is left out (its address would not open here). */
export const fileItems = (hits: readonly SearchFileHit[], slug: string, teamId: string | null): SwitcherItem[] =>
  hits
    .filter((h) => teamId === null || h.channel === null || h.channel.teamId === teamId)
    .map((h) => item({ key: `file:${h.id}`, kind: 'file', label: h.name, hint: h.channel?.name ? `File · #${bare(h.channel.name)}` : 'File', to: `${teamPath(slug, 'files')}?open=${encodeURIComponent(`${h.folderPath}${h.name}`)}` }));

const MAX_ROWS = 50;

/** How well a name fits what was typed: 0 is the whole name, 1 its start, 2 the start of a word in it, 3 anywhere in it; null is no match. */
export const matchRank = (label: string, query: string): number | null => {
  const name = label.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  const at = name.indexOf(query);
  if (at < 0) return null;
  return /[\s\-_/.]/.test(name.charAt(at - 1)) ? 2 : 3;
};

/**
 * The rows for a query: every item whose name carries it (case-insensitive, a leading `#` optional), best fit first, then by kind, then in the
 * order given. An empty query lists by kind (channels first), cut to a screenful.
 */
export const rankItems = (items: readonly SwitcherItem[], query: string): SwitcherItem[] => {
  const q = query.trim().replace(/^#/, '').toLowerCase();
  const kindAt = (k: SwitcherKind): number => KIND_ORDER.indexOf(k);
  const scored = items.flatMap((it, i) => {
    const rank = q ? matchRank(it.label, q) : 0;
    return rank === null ? [] : [{ it, rank, i }];
  });
  scored.sort((a, b) => a.rank - b.rank || kindAt(a.it.kind) - kindAt(b.it.kind) || a.i - b.i);
  return scored.slice(0, MAX_ROWS).map((s) => s.it);
};

/* ---- unread jumps ------------------------------------------------------------------------------------------------------------------ */

/** A conversation that can hold unread messages, in the order Alt+Down walks them: channels in sidebar order, then direct messages. */
export type UnreadStop = { id: string; to: string };

/**
 * Where Alt+Down (`dir` 1) or Alt+Up (`dir` -1) goes: the next conversation after the current one that has unread messages, wrapping round the
 * list; null when nothing else is unread. The conversation you are in is never the answer.
 */
export const nextUnreadStop = (stops: readonly UnreadStop[], unread: Readonly<Record<string, number>>, currentId: string | null, dir: 1 | -1): UnreadStop | null => {
  const n = stops.length;
  if (n === 0) return null;
  const from = currentId === null ? -1 : stops.findIndex((s) => s.id === currentId);
  for (let step = 1; step <= n; step++) {
    const at = from < 0 ? (dir === 1 ? step - 1 : n - step) : (((from + dir * step) % n) + n) % n;
    const stop = stops[at];
    if (stop && stop.id !== currentId && (unread[stop.id] ?? 0) > 0) return stop;
  }
  return null;
};

/** The conversation open in the address bar: `/t/<team>/c/<name>` names a channel, `/t/<team>/dm/<id>` a direct message. */
export const openConversationOf = (pathname: string): { kind: 'channel'; name: string } | { kind: 'dm'; id: string } | null => {
  const m = /^\/t\/[^/]+\/(c|dm)\/([^/]+)\/?$/.exec(pathname);
  if (!m?.[2]) return null;
  let value = m[2];
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep the raw segment */
  }
  return m[1] === 'c' ? { kind: 'channel', name: value } : { kind: 'dm', id: value };
};

/* ---- recent places, one row per person, tabs ------------------------------------------------------------------------------------ */

/**
 * With nothing typed, the places the person was in last go first (most recent first); the rest keep their order. A typed query is left to
 * the ranking.
 */
export const withRecent = (items: readonly SwitcherItem[], recentKeys: readonly string[], query: string): SwitcherItem[] => {
  if (query.trim() !== '') return [...items];
  const byKey = new Map(items.map((it) => [it.key, it]));
  const recent = recentKeys.flatMap((k) => {
    const it = byKey.get(k);
    return it ? [it] : [];
  });
  const seen = new Set(recent.map((it) => it.key));
  return [...recent, ...items.filter((it) => !seen.has(it.key))];
};

/**
 * Drops the person row of anyone you already have a 1:1 conversation with: the conversation row says the same thing and opens the same
 * place. `dms` are the summaries whose other participants are looked up by person id.
 */
export const dedupePeople = (items: readonly SwitcherItem[], dms: readonly DirectMessageSummary[], selfPersonId: string): SwitcherItem[] => {
  const withDm = new Set<string>(
    dms.flatMap((d) => {
      const others = d.participants.filter((p) => p.personId !== selfPersonId);
      return others.length === 1 && others[0] ? [others[0].personId] : [];
    }),
  );
  return items.filter((it) => !(it.kind === 'person' && it.personId !== null && withDm.has(it.personId)));
};

export type SwitcherTab = 'all' | 'channels' | 'people' | 'bots' | 'files';
export const SWITCHER_TABS: ReadonlyArray<{ id: SwitcherTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'channels', label: 'Channels' },
  { id: 'people', label: 'People' },
  { id: 'bots', label: 'Bots' },
  { id: 'files', label: 'Files' },
];
const TAB_KINDS: Readonly<Record<SwitcherTab, readonly SwitcherKind[] | null>> = {
  all: null,
  channels: ['channel'],
  people: ['dm', 'person'],
  bots: ['bot'],
  files: ['file', 'page'],
};
export const filterByTab = (items: readonly SwitcherItem[], tab: SwitcherTab): SwitcherItem[] => {
  const kinds = TAB_KINDS[tab];
  return kinds ? items.filter((it) => kinds.includes(it.kind)) : [...items];
};

/** The tab Tab (dir 1) or Shift+Tab (dir -1) moves to, wrapping round. */
export const nextTab = (tab: SwitcherTab, dir: 1 | -1): SwitcherTab => {
  const at = SWITCHER_TABS.findIndex((t) => t.id === tab);
  return SWITCHER_TABS[(at + dir + SWITCHER_TABS.length) % SWITCHER_TABS.length]?.id ?? 'all';
};
