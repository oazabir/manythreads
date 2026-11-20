import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { People } from '../src/channels/hooks';
import { PinnedMark } from '../src/channels/MessageRow';
import { PIN_EXCERPT_CHARS, PINS_PANEL, pinExcerpt, pinsListChanged } from '../src/channels/pinsModel';
import type { ChannelMessage } from '@manythreads/shared';
import { filterChips } from '../src/search/SearchFilterBar';
import { parseSearchText } from '@manythreads/shared';
import { SurfaceHostContext, type SurfaceHost } from '../src/surfaces/host';
import { Lookups, buildPageHost, personOf } from '../src/surfaces/pageHost';
import { Surface } from '../src/surfaces/Surface';

// P31-07 (pins) and P9-05 (chips that show names and open): the pieces a test can run without a browser.

const NADIA = { personId: 'p-nadia', actorId: 'a-nadia', name: 'Nadia Hamdan', email: 'nadia@example.org', role: 'member', avatar: null };
const people = {
  loaded: true,
  settled: true,
  list: [NADIA],
  bots: [],
  botActors: [],
  byActor: (id: string) => (id === NADIA.actorId ? NADIA : undefined),
  byPerson: (id: string) => (id === NADIA.personId ? NADIA : undefined),
  botAvatar: () => undefined,
  botName: (id: string) => (id === 'a-bot' ? 'Release bot' : undefined),
  botAvatarBySlug: () => undefined,
  isBotHandle: () => false,
  me: undefined,
  canModerate: false,
} as unknown as People;

describe('the pinned list and the pin mark', () => {
  it('the panel type is pins, and an excerpt keeps short text whole and cuts long text at a word', () => {
    expect(PINS_PANEL).toBe('pins');
    expect(pinExcerpt({ body: 'raw', bodyPlain: '  Release   notes\nhere ' })).toBe('Release notes here');
    expect(pinExcerpt({ body: 'only body', bodyPlain: '' })).toBe('only body');
    const long = `${'word '.repeat(100)}end`;
    const cut = pinExcerpt({ body: long, bodyPlain: long });
    expect(cut.length).toBeLessThanOrEqual(PIN_EXCERPT_CHARS + 1);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/wor…$/);
  });

  it('the mark says Pinned and who pinned it, a person or a bot, or nobody it can name', () => {
    expect(renderToStaticMarkup(createElement(PinnedMark, { by: NADIA.actorId, people }))).toContain('title="Pinned by Nadia Hamdan"');
    expect(renderToStaticMarkup(createElement(PinnedMark, { by: 'a-bot', people }))).toContain('title="Pinned by Release bot"');
    const unknown = renderToStaticMarkup(createElement(PinnedMark, { by: null, people }));
    expect(unknown).toContain('title="Pinned to the channel"');
    expect(unknown).toContain('Pinned');
  });

  it('the list reads again when a message of its channel is deleted or edited, not for a new message or another channel', () => {
    const inCh = { channelId: 'c-1' } as ChannelMessage;
    const elsewhere = { channelId: 'c-2' } as ChannelMessage;
    expect(pinsListChanged({ type: 'deleted', channelId: 'c-1', messageId: 'm', threadRootId: null }, 'c-1')).toBe(true);
    expect(pinsListChanged({ type: 'deleted', channelId: 'c-2', messageId: 'm', threadRootId: null }, 'c-1')).toBe(false);
    expect(pinsListChanged({ type: 'edited', message: inCh }, 'c-1')).toBe(true);
    expect(pinsListChanged({ type: 'edited', message: elsewhere }, 'c-1')).toBe(false);
    expect(pinsListChanged({ type: 'posted', message: inCh }, 'c-1')).toBe(false);
  });

  it('search shows has:pin as the chip "Pinned"', () => {
    const chips = filterChips(parseSearchText('has:pin release'));
    expect(chips.map((c) => c.label)).toEqual(['Pinned']);
    expect(chips[0]!.remove.has).toEqual([]);
  });
});

describe('chips look up as the viewer and open (P9-05)', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const make = (over: Partial<Parameters<typeof buildPageHost>[0]> = {}) => {
    const lookups = new Lookups();
    const go = vi.fn();
    const openMember = vi.fn();
    const loadChannel = vi.fn(async (id: string) => (id === 'c-ops' ? { name: 'ops', teamId: 't-eng' } : null));
    const loadCard = vi.fn(async (_slug: string, id: string) => (id === 'k-1' ? { label: 'Ship the fix', summary: 'In progress' } : null));
    const loadApprovals = vi.fn(async () => new Map([['ap-1', 'waiting' as const]]));
    const host = buildPageHost({ people, teamSlug: 'engineering', slugOf: (t) => (t === 't-eng' ? 'engineering' : null), lookups, go, openMember, loadChannel, loadCard, loadApprovals, ...over });
    return { host, lookups, go, openMember, loadChannel, loadCard, loadApprovals };
  };

  it('a person is found by person id or actor id and opens their member card; anyone else keeps the label', () => {
    const { host, openMember } = make();
    expect(personOf(people, NADIA.actorId)?.personId).toBe(NADIA.personId);
    expect(host.personName?.(NADIA.personId)).toBe('Nadia Hamdan');
    expect(host.personName?.(NADIA.actorId)).toBe('Nadia Hamdan');
    expect(host.personName?.('p-stranger')).toBeNull();
    host.openPerson?.(NADIA.actorId);
    expect(openMember).toHaveBeenCalledWith(NADIA.personId);
    host.openPerson?.('p-stranger');
    expect(openMember).toHaveBeenCalledTimes(1);
  });

  it('a channel, a card and an approval are fetched once, after the render, and then known; each opens at a link built from its id', async () => {
    const { host, go, loadChannel, loadCard, loadApprovals } = make();
    expect(host.channelName?.('c-ops')).toBeNull();
    expect(host.entity?.('task', 'k-1')).toBeNull();
    expect(host.approvalStatus?.('ap-1')).toBeNull();
    expect(loadChannel).not.toHaveBeenCalled();   // never during the render itself
    await settle();
    await settle();
    expect(host.channelName?.('c-ops')).toBe('ops');
    expect(host.entity?.('task', 'k-1')).toEqual({ label: 'Ship the fix', summary: 'In progress' });
    expect(host.approvalStatus?.('ap-1')).toBe('waiting');
    expect(host.channelName?.('c-ops')).toBe('ops');
    expect(loadChannel).toHaveBeenCalledTimes(1);
    expect(loadCard).toHaveBeenCalledTimes(1);
    expect(loadApprovals).toHaveBeenCalledTimes(1);
    host.openChannel?.('c-ops');
    host.openEntity?.('task', 'k-1');
    host.openApproval?.('ap-1');
    expect(go.mock.calls.map((c) => c[0])).toEqual(['/t/engineering/c/ops', '/t/engineering/boards?card=k-1', '/t/engineering/approvals?approval=ap-1']);
  });

  it('a refused lookup leaves the label; a kind it cannot look up is not asked for; no team, no card', async () => {
    const { host, go, loadCard } = make({ loadChannel: async () => Promise.reject(new Error('403')) });
    host.channelName?.('c-hidden');
    host.entity?.('page', 'pg-1');
    await settle();
    await settle();
    expect(host.channelName?.('c-hidden')).toBeNull();
    host.openChannel?.('c-hidden');
    expect(go).not.toHaveBeenCalled();
    expect(loadCard).not.toHaveBeenCalled();
    const guest = make({ teamSlug: null });
    expect(guest.host.entity?.('task', 'k-1')).toBeNull();
    expect(guest.host.approvalStatus?.('ap-1')).toBeNull();
  });

  it('a finished lookup tells the screens to draw again, and clear forgets everything', async () => {
    const lookups = new Lookups();
    const heard = vi.fn();
    lookups.subscribe(heard);
    expect(lookups.get('k', async () => 'v')).toBeNull();
    await settle();
    await settle();
    expect(lookups.get('k', async () => 'other')).toBe('v');
    expect(heard).toHaveBeenCalledTimes(1);
    const before = lookups.snapshot();
    lookups.clear();
    expect(lookups.snapshot()).toBeGreaterThan(before);
    expect(lookups.get('k', async () => 'again')).toBeNull();
  });

  it('an answer asked for before a clear (the person changed) is dropped, even when the same key was asked again since', async () => {
    const lookups = new Lookups();
    let release: (v: string) => void = () => undefined;
    const slow = new Promise<string>((r) => (release = r));
    expect(lookups.get('k', () => slow)).toBeNull();
    await settle();   // the old request has started
    lookups.clear();
    expect(lookups.get('k', () => new Promise<string>(() => undefined))).toBeNull();   // asked again by the new person, still loading
    release('for the old person');
    await settle();
    await settle();
    expect(lookups.get('k', async () => 'unused')).toBeNull();
  });

  it('the parts draw buttons that open only for what the host found, and the approval part never decides', () => {
    const calls: string[] = [];
    const host: SurfaceHost = {
      personName: (id) => (id === 'u-1' ? 'Samira Khan' : null),
      openPerson: (id) => void calls.push(`person:${id}`),
      entity: (type, id) => (type === 'task' && id === 't-1' ? { label: 'Real title' } : null),
      openEntity: (type, id) => void calls.push(`${type}:${id}`),
      approvalStatus: (id) => (id === 'ap-1' ? 'waiting' : null),
      openApproval: (id) => void calls.push(`approval:${id}`),
    };
    const source = ['root = Stack([p, q, e, f, a, b])', 'p = PersonChip("u-1", "Bot name")', 'q = PersonChip("u-9", "Unknown")', 'e = EntityCard("task", "t-1", "Bot title")', 'f = EntityCard("task", "t-9", "Hidden card")', 'a = ApprovalCard("ap-1", "Send the mail")', 'b = ApprovalCard("ap-9", "Not yours")', ''].join('\n');
    const out = renderToStaticMarkup(createElement(SurfaceHostContext.Provider, { value: host }, createElement(Surface, { source, ended: true })));
    expect(out).toContain('<button type="button" class="sf-chip sf-chip-person sf-chip-link" data-resolved="true">Samira Khan</button>');
    expect(out).toContain('<span class="sf-chip sf-chip-person" data-resolved="false">Unknown</span>');
    expect(out).toMatch(/<button type="button" class="sf-entity sf-entity-link" data-entity-type="task" data-resolved="true">.*Real title/);
    expect(out).toMatch(/<div class="sf-entity" data-entity-type="task" data-resolved="false">.*Hidden card/);
    // one way to the list for the approval the page found, none for the other; no Approve or Deny anywhere
    expect(out.split('Open in Approvals').length - 1).toBe(1);
    expect(out).not.toMatch(/>(Approve|Deny|Decline)</);
  });
});
