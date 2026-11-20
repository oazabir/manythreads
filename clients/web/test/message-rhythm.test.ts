// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '@manythreads/shared';
import type { People } from '../src/channels/hooks';
import { MessageRow, type RowActions } from '../src/channels/MessageRow';
import { isLongHash, withoutOwnName } from '../src/channels/displayText';

// P34-01: the message list's rhythm. What the row draws (the clamp, Show more, a hash, a handover's prefix) and the CSS rules the spacing rests on.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const BOT = uuid(3);

const people: People = {
  loaded: true,
  settled: true,
  list: [],
  bots: [],
  byActor: () => undefined,
  byPerson: () => undefined,
  botAvatar: () => undefined,
  botAvatarBySlug: () => undefined,
  isBotHandle: () => false,
  me: undefined,
  canModerate: false,
};
const actions: RowActions = { react: () => undefined, edit: () => Promise.resolve(), remove: () => Promise.resolve() };

function message(body: string, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: uuid(700),
    workspaceId: uuid(901),
    channelId: uuid(900),
    authorId: BOT,
    author: { actorId: BOT, kind: 'bot', displayName: 'Web smoke tester' },
    body,
    bodyPlain: body,
    threadRootId: null,
    editedAt: null,
    deletedAt: null,
    meta: {},
    attachments: [],
    createdAt: '2026-11-19T18:04:00.000Z',
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    ...over,
  } as unknown as ChannelMessage;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // no storage here
  }
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function draw(m: ChannelMessage, inThread = false): Promise<void> {
  await act(async () => {
    root.render(createElement(MessageRow, { message: m, teamSlug: null, people, selfActor: null, canPost: true, inThread, actions }));
  });
}

describe('a handover drops the author name the header already shows', () => {
  it('takes off only an exact "Name → " at the start', () => {
    expect(withoutOwnName('Web smoke tester → @committer: all green', 'Web smoke tester')).toBe('→ @committer: all green');
    expect(withoutOwnName('Omar → @plan-reviewer: “Plan”', 'Omar')).toBe('→ @plan-reviewer: “Plan”');
    // another name, no arrow, the name alone, or the name in the middle: as written
    expect(withoutOwnName('Nadia → @committer: hi', 'Omar')).toBe('Nadia → @committer: hi');
    expect(withoutOwnName('Omar said hi', 'Omar')).toBe('Omar said hi');
    expect(withoutOwnName('Omar → ', 'Omar')).toBe('Omar → ');
    expect(withoutOwnName('I asked Omar → @x', 'Omar')).toBe('I asked Omar → @x');
    expect(withoutOwnName('anything', '  ')).toBe('anything');
  });

  it('the row draws "→ @committer" under the header with the name', async () => {
    await draw(message('Web smoke tester → @committer: all green'));
    expect(host.querySelector('.who b')?.textContent).toBe('Web smoke tester');
    expect(host.querySelector('.txt')?.textContent).toBe('→ @committer: all green');
  });
});

describe('a commit hash in a code span is drawn short', () => {
  it('knows a hash: hex only, more than twelve, with a digit', () => {
    expect(isLongHash('8ac36456d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6')).toBe(true);
    expect(isLongHash('8ac36456d1e2f')).toBe(true);
    expect(isLongHash('8ac36456d1e2')).toBe(false); // twelve: short enough already
    expect(isLongHash('deadbeefcafebabe')).toBe(false); // no digit: a word, not a hash
    expect(isLongHash('8ac36456-d1e2-f3a4')).toBe(false);
    expect(isLongHash('1732101234567')).toBe(false); // a millisecond time: a number, not a hash
    expect(isLongHash('4155550123456789')).toBe(false); // an order id or a phone number
    expect(isLongHash('src/channels/MessageRow.tsx')).toBe(false);
  });

  it('keeps the whole value in the text (what a selection copies) and in the tooltip; other code spans are plain', async () => {
    const hash = '8ac36456d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6';
    await draw(message(`Merged \`${hash}\` from \`main\``));
    const codes = [...host.querySelectorAll('.txt code')];
    expect(codes).toHaveLength(2);
    expect(codes[0]?.classList.contains('md-hash')).toBe(true);
    expect(codes[0]?.getAttribute('title')).toBe(hash);
    expect(codes[0]?.textContent).toBe(hash);
    expect(codes[1]?.classList.contains('md-hash')).toBe(false);
    expect(codes[1]?.hasAttribute('title')).toBe(false);
  });
});

describe('a long text', () => {
  const long = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long report.`).join('\n\n');
  beforeEach(() => {
    // jsdom lays nothing out: the text says it is taller than six lines
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
  });

  it('is cut in the channel, with Show more on its own line under the text and outside the reply count', async () => {
    await draw(message(long, { id: uuid(701) as ChannelMessage['id'], replyCount: 3, lastReplyAt: '2026-11-19T18:10:00.000Z' }));
    const txt = host.querySelector('.txt');
    expect(txt?.classList.contains('clamp')).toBe(true);
    const more = host.querySelector('.show-more');
    expect(more?.textContent).toBe('Show more');
    // right under the text, not inside the replies button
    expect(txt?.nextElementSibling).toBe(more);
    expect(more?.closest('.replies')).toBeNull();
    expect(host.querySelector('.replies')).not.toBeNull();
  });

  it('is drawn whole in the thread pane: no clamp and no Show more', async () => {
    await draw(message(long, { id: uuid(702) as ChannelMessage['id'] }), true);
    expect(host.querySelector('.txt')?.classList.contains('clamp')).toBe(false);
    expect(host.querySelector('.show-more')).toBeNull();
  });
});

/** The body of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `a rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

describe('the CSS the rhythm rests on', () => {
  const css = readFileSync(join(__dirname, '../src/styles/channels.css'), 'utf8');
  const tokens = readFileSync(join(__dirname, '../src/styles/tokens.css'), 'utf8');

  it('the gap between rows sits on top of a row that starts a group, never under a row', () => {
    expect(rule(css, '.vrow')).not.toMatch(/padding-bottom/);
    expect(rule(css, '.vrow > :where(.msg:not(.run))')).toMatch(/margin-top: var\(--group-gap\)/);
    // under a row and over a run row: half of the run gap each
    expect(rule(css, '.msg')).toMatch(/padding: var\(--msg-pad-y\) 8px var\(--run-pad\)/);
    expect(rule(css, '.msg.run')).toMatch(/padding-top: var\(--run-pad\)/);
    expect(css).toMatch(/--run-pad: calc\(var\(--run-gap\) \/ 2\)/);
    // comfortable: 4 px between two lines of a run; compact: 2 px
    expect(tokens).toMatch(/--run-gap: 4px;/);
    expect(tokens).toMatch(/:root\[data-density="compact"\][^}]*--run-gap: 2px;/);
  });

  it('the floating day pill sits on a solid band; Show more is a block; the fade covers one line; prose breaks words only when it must', () => {
    expect(rule(css, '.day-float')).toMatch(/background: var\(--surface\)/);
    expect(rule(css, '.link-btn.show-more')).toMatch(/display: block/);
    expect(rule(css, '.txt.clamp')).toMatch(/calc\(100% - var\(--lh\)\)/);
    expect(rule(css, '.md')).toMatch(/overflow-wrap: break-word/);
    expect(rule(css, '.md code')).toMatch(/overflow-wrap: anywhere/);
  });
});
