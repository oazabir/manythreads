import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChannelMessage, LinkPreview } from '@manythreads/shared';
import { buildListItems, type ListItem } from '../src/channels/listItems';
import { allShownAbove, linksAboveEach, messageLinks, normalizeLink, splitLinksAbove, threadLinksAbove } from '../src/linkpreview/dedupe';
import { Card, cardShape, descLines } from '../src/linkpreview/LinkPreviewCards';

// P34-04: a link's preview is shown once inside a thread and once per author's run in a channel; a title-only page is one line; the description is
// clamped by whole lines.

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2026-11-20T10:00:00.000Z');
const at = (ms: number): string => new Date(AT + ms).toISOString();
const NADIA = uuid(2);
const BOT = uuid(3);
const PR = 'https://github.com/kahf/manythreads/pull/17';
const SITE = 'https://test-manythreads.kahf.to/';

function msg(n: number, body: string, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: uuid(100 + n),
    workspaceId: uuid(9),
    channelId: uuid(8),
    authorId: NADIA,
    author: { actorId: NADIA, kind: 'person', displayName: 'Nadia' },
    body,
    bodyPlain: body,
    threadRootId: null,
    editedAt: null,
    deletedAt: null,
    meta: {},
    createdAt: at(n * 30_000),
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    ...over,
  } as ChannelMessage;
}
const bot = (n: number, body: string, over: Partial<ChannelMessage> = {}): ChannelMessage =>
  msg(n, body, { authorId: BOT as ChannelMessage['authorId'], author: { actorId: BOT, kind: 'bot', displayName: 'Web smoke tester' } as ChannelMessage['author'], ...over });

const card = (url: string, over: Partial<LinkPreview> = {}): LinkPreview => ({
  id: uuid(900),
  channelId: uuid(8) as LinkPreview['channelId'],
  messageId: uuid(101) as LinkPreview['messageId'],
  url,
  host: new URL(url).hostname,
  title: 'Pull request 17',
  description: null,
  siteName: null,
  hasImage: false,
  canRemove: false,
  createdAt: at(0),
  ...over,
});

const items = (messages: ChannelMessage[], pageStarts: string[] = []): Array<Extract<ListItem, { kind: 'message' }>> =>
  buildListItems(messages, [], { lastReadId: null, selfActor: null, allLoaded: true, readKnown: false, now: new Date(AT), pageStarts }).filter(
    (i): i is Extract<ListItem, { kind: 'message' }> => i.kind === 'message',
  );

describe('messageLinks: the links the server makes cards for', () => {
  it('reads bare links and markdown link targets in order, without repeats, and drops sentence marks', () => {
    expect(messageLinks(`see ${PR}. and [the site](${SITE}) and ${PR}`)).toEqual([PR, SITE]);
  });

  it('spells a link as the card stores it: no fragment, no user name, root path with a slash; a trailing slash elsewhere is kept as written', () => {
    expect(normalizeLink('https://user:pw@a.example#top')).toBe('https://a.example/');
    expect(normalizeLink('https://a.example/x/')).toBe('https://a.example/x/');
    expect(normalizeLink('https://a.example/x')).toBe('https://a.example/x');
    expect(messageLinks('https://a.example and https://a.example/#b')).toEqual(['https://a.example/']);
  });

  it('skips links inside code, other schemes, odd ports and hosts without a dot, as the server does', () => {
    expect(messageLinks('`https://a.example/x` http://localhost/ https://a.example:8443/ ftp://a.example/')).toEqual([]);
  });
});

describe('inside a thread', () => {
  it('a link the root or an earlier reply carries is shown above every later reply, whoever wrote it', () => {
    const root = msg(0, `PR ${PR}`);
    const replies = [bot(1, `reviewing ${PR}`), msg(2, `site is up ${SITE}`), bot(3, `${PR} and ${SITE} pass`)];
    const above = threadLinksAbove(root, replies).map((s) => [...splitLinksAbove(s)]);
    expect(above).toEqual([[PR], [PR], [PR, SITE]]);
  });

  it('a message with a new link next to a repeated one asks for its cards and shows them all (a row never shrinks once drawn)', () => {
    const above = splitLinksAbove(threadLinksAbove(msg(0, PR), [bot(1, `${PR} and https://github.com/kahf/manythreads/pull/18`)])[0]);
    const own = messageLinks(`${PR} and https://github.com/kahf/manythreads/pull/18`);
    expect(allShownAbove(own, above)).toBe(false);
  });

  it('a deleted message counts for nothing', () => {
    const above = threadLinksAbove(null, [msg(1, PR, { deletedAt: at(1) }), bot(2, PR)]);
    expect(above[1]).toBe('');
  });

  it('a page of earlier replies loaded later does not hide a card already shown under the first reply of the page before', () => {
    const replies = [bot(1, PR), bot(2, PR), bot(3, PR)];
    expect(threadLinksAbove(null, replies, [replies[2]!.id])).toEqual(['', PR, '']);
  });
});

describe('in a channel: once per author run', () => {
  it('the second message of a run with the same link shows no card, the first one does', () => {
    const list = items([bot(1, `PR ${PR}`), bot(2, `still ${PR}`), bot(3, `again ${PR}`)]);
    expect(list.map((i) => i.continued)).toEqual([false, true, true]);
    expect(list.map((i) => i.linksAbove)).toEqual(['', PR, PR]);
  });

  it('another author starts afresh: the same link gets its card again', () => {
    const list = items([bot(1, PR), msg(2, PR), msg(3, PR)]);
    expect(list.map((i) => i.linksAbove)).toEqual(['', '', PR]);
  });

  it('a run broken by time (more than five minutes) starts afresh', () => {
    const list = items([bot(1, PR), bot(30, PR)]);
    expect(list[1]!.continued).toBe(false);
    expect(list[1]!.linksAbove).toBe('');
  });

  it('never across loaded pages: the first message of a page loaded earlier keeps its card when older messages arrive above it', () => {
    const older = bot(1, PR);
    const first = bot(2, PR);
    const list = items([older, first, bot(3, PR)], [first.id]);
    expect(list.map((i) => i.continued)).toEqual([false, true, true]);
    expect(list.map((i) => i.linksAbove)).toEqual(['', '', PR]);
  });

  it('a message whose every link was shown above asks for nothing; one with no links of its own is not skipped', () => {
    expect(allShownAbove([PR], new Set([PR]))).toBe(true);
    expect(allShownAbove([], new Set([PR]))).toBe(false);
    expect(allShownAbove([PR], new Set())).toBe(false);
  });

  it('several messages: groups start where told, seeded links count everywhere', () => {
    const list = [msg(1, PR), msg(2, SITE), msg(3, PR)];
    expect(linksAboveEach(list, (i) => i === 2, [SITE])).toEqual([SITE, `${SITE} ${PR}`, SITE]);
  });
});

describe('the card layout', () => {
  it('a page with only a title is one line; a description or a picture makes the full card; a broken picture leaves one line', () => {
    expect(cardShape({ description: null, hasImage: false })).toBe('line');
    expect(cardShape({ description: '  ', hasImage: false })).toBe('line');
    expect(cardShape({ description: 'text', hasImage: false })).toBe('full');
    expect(cardShape({ description: null, hasImage: true })).toBe('full');
    expect(cardShape({ description: null, hasImage: true }, true)).toBe('line');
  });

  it('the description takes one whole line under a two-line title, two under a one-line title', () => {
    expect(descLines(2)).toBe(1);
    expect(descLines(1)).toBe(2);
  });

  it('draws the title-only card with the one-line class and the full card without it', () => {
    const line = renderToStaticMarkup(createElement(Card, { card: card(SITE, { title: 'manythreads test site' }) }));
    expect(line).toContain('class="lp-card lp-line"');
    expect(line).toContain('data-shape="line"');
    expect(line).not.toContain('lp-desc');
    const full = renderToStaticMarkup(createElement(Card, { card: card(PR, { description: 'Adds the thing' }) }));
    expect(full).toContain('class="lp-card"');
    expect(full).toContain('data-shape="full"');
    // before it is measured the title counts as one line: two lines of description
    expect(full).toContain('class="lp-desc"');
  });

  it('the remove button is drawn only for someone who may remove the card for everyone', () => {
    expect(renderToStaticMarkup(createElement(Card, { card: card(PR, { canRemove: true }) }))).toContain('data-testid="link-preview-remove"');
    expect(renderToStaticMarkup(createElement(Card, { card: card(PR) }))).not.toContain('link-preview-remove');
  });
});
