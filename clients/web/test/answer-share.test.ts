import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AnswerPayloadView, AnswerSharePreview, removeClaims } from '@manythreads/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, setTransport, type TransportRequest } from '../src/api/client';
import { Answer, maskedLine, shareNote } from '../src/channels/Answer';
import { parseMarkdown, type Block, type Inline } from '../src/channels/markdown';
import { ShareDialogView, refusalOf, type ShareDialogViewProps } from '../src/channels/AnswerShare';
import { fetchShareTargets, handoffAnswer, previewAnswerShare, saveAnswerAsPage, shareAnswer } from '../src/screens/conversations/api';

// Share, save as page, hand to a bot (PLAN P5-17): how a copy with a masked source is drawn, what the preview dialog shows, and that each call
// reaches the route the conversations / pages plugins mount with a body that names claims by number and carries no text.

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const DIGEST = 'a'.repeat(64);

const copy = (over: Record<string, unknown> = {}) =>
  AnswerPayloadView.parse({
    version: 1,
    body: 'The deploy waits for the Monday window [1]. Leadership also has plans [2] that I cannot repeat.',
    citations: [
      { kind: 'message', n: 1, label: 'The deploy waits for the Monday change window', scope: 'team', messageId: uuid(10), channelId: uuid(11), teamId: uuid(12), channelKind: 'channel', channelName: 'dev', threadRootId: null },
      { kind: 'masked', n: 2, source: 'message' },
      { kind: 'masked', n: 3, source: 'drive' },
    ],
    lineage: [
      { n: 1, kind: 'message', label: 'The deploy waits for the Monday change window', at: '2026-10-01T12:00:00.000Z', snippet: 'waits for the Monday window' },
      { n: 2, kind: 'message', label: '', at: null, snippet: null, masked: true },
      { n: 3, kind: 'drive', label: '', at: null, snippet: null, masked: true },
    ],
    sourcesReached: [],
    outsideScope: { count: 0, items: [] },
    answeredFor: { personId: uuid(20), name: 'Omar', scope: 'scoped', alias: 'smart', botId: uuid(21), runId: uuid(22) },
    chips: [],
    share: { masked: 2, removed: 1 },
    ...over,
  });

const html = (p = copy()): string =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Answer, { payload: p, teamSlug: 'engineering', teamSlugOf: (id) => (id === uuid(12) ? 'engineering' : null) })));

describe('a shared copy', () => {
  it('draws a source its readers may not open as "from <person>’s <kind> · not shared", with no link and no label', () => {
    const out = html();
    expect(out).toContain('data-kind="masked"');
    expect(out).toContain('from Omar’s message · not shared');
    expect(out).toContain('from Omar’s Drive · not shared');
    expect(out).toContain('data-testid="answer-citation" data-kind="masked" data-n="2" data-source="message"');
    // the number in the text stays, muted, and says why
    expect(out).toContain('an-ref an-ref-masked');
    expect(out).toContain('title="from Omar’s message · not shared"');
    // the kept one is still a link to its message
    expect(out).toContain('aria-label="Source 1: The deploy waits for the Monday change window"');
  });

  it('says in the Lineage that the snippet was removed, and says how the copy was cut', () => {
    const out = html();
    expect(out).toContain('data-masked="true"');
    expect(out).toContain('snippet removed');
    expect(out).toContain('Shared by Omar · 2 sources not shared · 1 claim removed');
    expect(shareNote('Omar', { masked: 1, removed: 0 })).toBe('Shared by Omar · 1 source not shared');
    expect(shareNote(null, { masked: 0, removed: 2 })).toBe('Shared by the person who asked · 2 claims removed');
    expect(maskedLine(null, 'page')).toBe('from the asker’s page · not shared');
    // a copy that was not cut says nothing about it
    expect(html(copy({ share: undefined }))).not.toContain('Shared by');
  });

  it('keeps chips inert where nothing acts on them (a copy has none, and a bot’s answer read by someone else is only drawn)', () => {
    const withChips = copy({ chips: [{ kind: 'handoff', botId: uuid(23), botSlug: 'coder', botName: 'Coder' }] });
    const out = html(withChips);
    expect(out).toContain('<span class="an-chip an-chip-bot"');
    expect(out).not.toContain('<button');
  });
});

const preview = AnswerSharePreview.parse({
  target: { kind: 'channel', channelId: uuid(31), name: 'releases', private: false, path: null },
  audience: 'team',
  items: [
    { n: 1, kind: 'message', status: 'kept', label: '#dev message Tue' },
    { n: 2, kind: 'message', status: 'masked', label: 'Layoffs are planned for March' },
    { n: 3, kind: 'drive', status: 'removed', label: 'Q3 plan.pdf' },
  ],
  counts: { kept: 1, masked: 1, removed: 1, sentences: 1, sourcesDropped: 0 },
  removedText: ['A claim that rested on the removed source [3].'],
  payload: {
    version: 1,
    body: 'One claim [1].',
    citations: [],
    lineage: [],
    sourcesReached: [],
    outsideScope: { count: 0, items: [] },
    answeredFor: { personId: uuid(20), name: 'Omar', scope: 'scoped', alias: null, botId: uuid(21), runId: uuid(22) },
    chips: [],
  },
  digest: DIGEST,
});

const view = (over: Partial<ShareDialogViewProps> = {}): string =>
  renderToStaticMarkup(
    createElement(ShareDialogView, {
      mode: 'channel',
      targets: [
        { id: uuid(31) as never, name: 'releases', private: false, teamSlug: 'engineering', teamName: 'Engineering' },
        { id: uuid(32) as never, name: 'leads', private: true, teamSlug: 'engineering', teamName: 'Engineering' },
      ],
      targetId: uuid(31),
      onTarget: () => undefined,
      preview,
      loading: false,
      error: null,
      removed: new Set<number>(),
      onToggle: () => undefined,
      who: 'Omar',
      busy: false,
      onConfirm: () => undefined,
      onCancel: () => undefined,
      ...over,
    }),
  );

describe('the share preview dialog', () => {
  it('lists each citation with kept, not shared or removed, a toggle per claim, and Cancel and Share', () => {
    const out = view({ removed: new Set([3]) });
    expect(out).toContain('data-testid="answer-share-item" data-n="1" data-status="kept"');
    expect(out).toContain('data-n="2" data-status="masked"');
    expect(out).toContain('data-n="3" data-status="removed"');
    expect(out).toContain('from Omar’s message · not shared');
    // the masked source's own label is the sharer's to see, labelled as such
    expect(out).toContain('was: Layoffs are planned for March');
    expect(out).toContain('Remove claim on 1');
    expect(out).toContain('aria-label="Keep the claim on 3"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('data-testid="answer-share-cancel"');
    expect(out).toContain('data-testid="answer-share-confirm"');
    expect(out).toContain('1 kept · 1 not shared · 1 removed');
  });

  it('offers only the channels the server listed, and Share is off until there is a preview of a chosen channel', () => {
    const out = view({ targetId: '', preview: null });
    expect(out).toContain('# releases · Engineering');
    expect(out).toContain('# leads · private · Engineering');
    expect(out).toMatch(/data-testid="answer-share-confirm"[^>]*disabled/);
    const ready = view();
    expect(ready).not.toMatch(/data-testid="answer-share-confirm"[^>]*disabled/);
    // a wider audience is said, and the page says where it lands and that the team can open it
    expect(view({ preview: AnswerSharePreview.parse({ ...preview, audience: 'wider' }) })).toContain('People outside the team may read # releases');
    const page = view({ mode: 'page', targets: [], targetId: '', preview: AnswerSharePreview.parse({ ...preview, target: { kind: 'page', channelId: null, name: null, private: false, path: 'pages/answers/2026-10-13-x-0000abcd.md' } }) });
    expect(page).toContain('pages/answers/2026-10-13-x-0000abcd.md');
    expect(page).toContain('Save as page');
  });

  it('shows exactly what goes and what is posted: the words taken out with each removed claim, and the text as it will read', () => {
    const out = view({ removed: new Set([3]) });
    expect(out).toContain('data-testid="answer-share-gone"');
    expect(out).toContain('A claim that rested on the removed source [3].');
    expect(out).toContain('data-testid="answer-share-body"');
    expect(out).toContain('One claim [1].');
    const none = view({ preview: AnswerSharePreview.parse({ ...preview, removedText: [] }) });
    expect(none).not.toContain('answer-share-gone');
  });

  it('a 409 is not an error to retry: its words stay above the preview that was read again', () => {
    const conflict = new ApiError({ code: 'conflict', status: 409, message: 'This answer would now read differently in that channel.' });
    expect(refusalOf(conflict, 'It could not be shared.')).toEqual({ error: null, notice: 'This answer would now read differently in that channel.', reread: true });
    expect(refusalOf(new ApiError({ code: 'forbidden', status: 403, message: 'You can read that channel but not post in it' }), 'x')).toEqual({
      error: 'You can read that channel but not post in it',
      notice: null,
      reread: false,
    });
    expect(refusalOf(new Error('boom'), 'x')).toEqual({ error: 'boom', notice: null, reread: false });
    // and the view says it, as a status, next to a preview that is there
    const out = view({ notice: 'This answer would now read differently in that channel.' });
    expect(out).toContain('data-testid="answer-share-changed"');
    expect(out).toContain('role="status"');
    expect(out).toContain('would now read differently');
    expect(out).toContain('data-testid="answer-share-items"');
  });

  it('shows a refusal in an alert, and an empty list of channels in words', () => {
    expect(view({ error: 'You can read that channel but not post in it' })).toContain('role="alert"');
    expect(view({ targets: [], targetId: '', preview: null })).toContain('There is no channel you can post in.');
    expect(view({ busy: true })).toContain('Working…');
  });
});

let seen: TransportRequest[] = [];
const MESSAGE = uuid(41);
const CHAT = uuid(42);
const base = `/api/channels/${CHAT}/messages/${MESSAGE}/answer`;

beforeEach(() => {
  seen = [];
  setTransport(async (req) => {
    seen.push(req);
    const key = `${req.method} ${req.url.split('?')[0]}`;
    const replies: Record<string, unknown> = {
      [`GET ${base}/targets`]: { channels: [{ id: uuid(31), name: 'releases', private: false, teamSlug: 'engineering', teamName: 'Engineering' }] },
      [`POST ${base}/preview`]: preview,
      [`POST ${base}/share`]: { messageId: uuid(50), channelId: uuid(31), replayed: false, counts: preview.counts },
      [`POST ${base}/page`]: { path: 'pages/answers/2026-10-13-x-0000abcd.md', created: true, counts: preview.counts },
      [`POST ${base}/handoff`]: { channelId: uuid(60), threadRootId: uuid(61), botSlug: 'coder', botName: 'Coder', replayed: false },
    };
    const body = replies[key];
    return body === undefined ? { status: 404, body: { error: { code: 'not_found', message: `no reply for ${key}` } } } : { status: 200, body };
  });
});

const last = (): TransportRequest => {
  const req = seen[seen.length - 1];
  if (!req) throw new Error('no request was sent');
  return req;
};
const bodyOf = (req: TransportRequest): unknown => JSON.parse(req.body ?? 'null');

describe('the answer endpoints', () => {
  const address = { channelId: CHAT, messageId: MESSAGE };

  it('lists targets for the answer’s own address', async () => {
    const res = await fetchShareTargets(address);
    expect(res.channels.map((c) => c.name)).toEqual(['releases']);
    expect(last()).toMatchObject({ method: 'GET', url: `${base}/targets` });
  });

  it('previews with the target and the numbers of the claims to remove, and nothing else', async () => {
    const res = await previewAnswerShare(address, { kind: 'channel', channelId: uuid(31) }, [3, 2]);
    expect(res.digest).toBe(DIGEST);
    expect(last()).toMatchObject({ method: 'POST', url: `${base}/preview` });
    expect(bodyOf(last())).toEqual({ target: { kind: 'channel', channelId: uuid(31) }, remove: [3, 2] });
    await previewAnswerShare(address, { kind: 'page' }, []);
    expect(bodyOf(last())).toEqual({ target: { kind: 'page' }, remove: [] });
  });

  it('shares, saves and hands over with the digest it was shown, and refuses a digest that is not one before sending', async () => {
    const shared = await shareAnswer(address, uuid(31), [2], DIGEST);
    expect(shared).toMatchObject({ replayed: false, channelId: uuid(31) });
    expect(last()).toMatchObject({ method: 'POST', url: `${base}/share` });
    expect(bodyOf(last())).toEqual({ targetChannelId: uuid(31), remove: [2], digest: DIGEST });

    const saved = await saveAnswerAsPage(address, [], DIGEST);
    expect(saved.created).toBe(true);
    expect(last()).toMatchObject({ method: 'POST', url: `${base}/page` });
    expect(bodyOf(last())).toEqual({ remove: [], digest: DIGEST });

    const handed = await handoffAnswer(address, uuid(23));
    expect(handed).toMatchObject({ botSlug: 'coder', threadRootId: uuid(61) });
    expect(bodyOf(last())).toEqual({ botId: uuid(23) });

    const before = seen.length;
    expect(() => shareAnswer(address, uuid(31), [], 'not-a-digest')).toThrow();
    expect(seen.length).toBe(before);
  });
});

// The guarantee of "Remove claim" is about what the READER sees, so it is tested against the client's own parser: every `[n]` that
// `MessageMarkdown` would draw as a citation marker (a text node of a paragraph, heading, quote or list item, after escapes and emphasis are
// read; never code) is collected, and none of the removed number may be left after `removeClaims`.
const renderedMarkers = (source: string): number[] => {
  const found: number[] = [];
  const inline = (nodes: Inline[]): void => {
    for (const n of nodes) {
      if (n.t === 'text') for (const m of n.v.matchAll(/\[(\d{1,3})\]/g)) found.push(Number(m[1]));
      else if (n.t === 'strong' || n.t === 'em' || n.t === 'del' || n.t === 'link') inline(n.c);
    }
  };
  const blocks = (list: Block[]): void => {
    for (const b of list) {
      if (b.t === 'p' || b.t === 'heading') inline(b.c);
      else if (b.t === 'quote') blocks(b.c);
      else if (b.t === 'list') b.items.forEach(inline);
    }
  };
  blocks(parseMarkdown(source));
  return found;
};

describe('Remove claim, against what the client draws as a marker', () => {
  const INLINE_FORMS = [
    '[2]',
    '\\[2\\]',
    '[2\\]',
    '\\[2]',
    '[002]',
    '[02]',
    '**[2]**',
    '*[2]*',
    '_[2]_',
    '~~[2]~~',
    '[[2]](https://example.com/x)',
    '[**[2]**](https://example.com/y)',
    '[[2]](javascript:alert(1))',
    '[x \\[2\\] y](https://example.com/z)',
    '(see [2])',
    '"[2]"',
    '\\\\[2]',
  ];
  const BLOCK_FORMS = ['> [2]', '# [2]', '- [2]', '1. [2]', '> **[2]**', '## \\[2\\]'];

  it('every form the client turns into a marker is removed with its sentence, and the neighbours stay', () => {
    for (const form of INLINE_FORMS) {
      const body = `Keep [1].\n\nThe claim ${form} stays here. After this one.\n\nTail [3].`;
      expect(renderedMarkers(body), `${form}: the client should draw it`).toContain(2);
      const out = removeClaims(body, new Set([2])).body;
      expect(renderedMarkers(out), `${form}: still drawn after the removal: ${JSON.stringify(out)}`).not.toContain(2);
      expect(out, form).toContain('Keep [1].');
      expect(out, form).toContain('Tail [3].');
    }
    for (const form of BLOCK_FORMS) {
      const body = `Keep [1].\n\n${form} The claim here. After this one.\n\nTail [3].`;
      expect(renderedMarkers(body), `${form}: the client should draw it`).toContain(2);
      const out = removeClaims(body, new Set([2])).body;
      expect(renderedMarkers(out), `${form}: still drawn after the removal: ${JSON.stringify(out)}`).not.toContain(2);
      expect(out, form).toContain('Keep [1].');
      expect(out, form).toContain('Tail [3].');
    }
  });

  it('a decorated marker written after a stop and a space belongs to the sentence before it: the claim goes, and so does the next sentence', () => {
    const forms = ['**[2]**', '\\[2\\]', '\\[2]', '[2\\]', '*[2]*', '_[2]_', '~~[2]~~', '([2])', '(see [2])', '"[2]"', '[[2]](https://example.com/x)', '[**[2]**](https://example.com/y)', '[see [2]](https://example.com/z)', '^[2]', '<sup>[2]</sup>', '「[2]」', '（[2]）'];
    for (const form of forms) {
      const body = `Keep [1].\n\nRevenue grew by four percent. ${form} Costs fell. After this one.\n\nTail [3].`;
      expect(renderedMarkers(body), `${form}: the client should draw it`).toContain(2);
      const out = removeClaims(body, new Set([2])).body;
      // the claim side: its words are gone (not only the marker), and what is not a neighbour stays
      expect(out, `${form}: the claim was kept: ${JSON.stringify(out)}`).not.toContain('Revenue grew');
      expect(renderedMarkers(out), form).not.toContain(2);
      expect(out, form).toContain('Keep [1].');
      expect(out, form).toContain('After this one.');
      expect(out, form).toContain('Tail [3].');
    }
    // a word with a marker on it belongs to its own sentence; a unit that opens with decoration follows a doubtful split (no letter after the
    // stop), so the sentence before it goes too: one neighbour is the price of never leaving half a claim behind
    expect(removeClaims('Revenue grew strongly. Costs[2] fell. After.', new Set([2])).body).toBe('Revenue grew strongly. After.');
    expect(removeClaims('Revenue grew strongly. **[1]** Costs fell [2]. After.', new Set([2])).body).toBe('After.');
  });

  it('forms the client does not turn into a marker are not touched: HTML entities and a link labelled with a bare number are text', () => {
    for (const body of ['A claim &#91;2&#93; here. Keep [1].', 'A claim &lbrack;2&rbrack; here. Keep [1].', 'A claim in a `[x]` span. Keep [1].']) {
      expect(renderedMarkers(body)).not.toContain(2);
      expect(removeClaims(body, new Set([2])).body).toBe(body);
    }
  });

  it('a sentence wrapped before a line that starts with # or | goes whole', () => {
    expect(removeClaims('It was ranked\n#1 overall [2]. Keep [1].', new Set([2])).body).toBe('Keep [1].');
    expect(removeClaims('It was ranked\n| first overall [2]. Keep [1].', new Set([2])).body).toBe('Keep [1].');
    // a real table row still goes whole, and a heading is its own block
    expect(removeClaims('# Title\nKeep [1].\n| a | b [2] |\n| c | d |', new Set([2])).body).toBe('# Title\nKeep [1].\n| c | d |');
  });

  it('whatever is written, no removed marker is left that the client would draw', () => {
    const pieces = ['[', ']', '2', '\\', '*', '_', '~', '`', '(', ')', 'https://x.y/z', ' ', '\n', '\n\n', '#', '> ', '- ', '1. ', 'a', '.', '. ', '[2]', '\\[', '\\]', '&#91;', '```\n', '[1]', '|', '**[2]**', '\\[2\\]', '(see [2])', '"[2]"', '. **[2]** ', '. ([2]) '];
    let s = 99;
    const next = (): number => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return s >>> 8;
    };
    for (let round = 0; round < 1_500; round += 1) {
      let text = '';
      const len = 1 + (next() % 60);
      for (let i = 0; i < len; i += 1) text += pieces[next() % pieces.length]!;
      const out = removeClaims(text, new Set([2])).body;
      expect(renderedMarkers(out), JSON.stringify({ text, out })).not.toContain(2);
    }
  });
});

describe('Remove claim: a marker at a sentence boundary, decorated at random', () => {
  const lcg = (seed: number): (() => number) => {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return s >>> 8;
    };
  };

  it('the sentences on both sides of the marker go, no other sentence does, and the client draws no removed marker', () => {
    const next = lcg(424_242);
    const pick = <T>(list: readonly T[]): T => list[next() % list.length]!;
    // decoration before and after the marker: ASCII and CJK punctuation, symbols, brackets, quotes, emphasis, tags, a link address
    const before = ['', '', '*', '**', '_', '~~', '(', '“', '"', '「', '（', '[', '^', '<sup>', '\\', '(see ', '[see ', '— ', '＊ ', '“**', '(_'];
    // (not `* `: after a line break that is a list item, a block of its own, and a marker at the start of a block belongs to that block)
    const after = ['', '', ']', ')', '”', '"', '」', '）', '*', '**', '</sup>', '\\', '](https://example.com/a/very/long/path/to/somewhere)', ' —', ')*', '”)'];
    const gapBefore = ['', ' ', '\n', '\u00a0', '\u2009'];
    const gapAfter = ['', ' ', ' ', '\n'];
    for (let round = 0; round < 800; round += 1) {
      const count = 3 + (next() % 4);
      const cjk = next() % 3 === 0;
      const stops = cjk ? ['。', '！', '？'] : ['.', '.', '!', '?'];
      const stopOf: string[] = [];
      const sentence = (i: number): string => {
        const stop = pick(stops);
        stopOf[i] = stop;
        return (cjk ? `Tok${String(round * 10 + i)}事実です` : `Tok${String(round * 10 + i)} says something`) + stop;
      };
      const boundary = next() % (count - 1);
      let text = '';
      for (let i = 0; i < count; i += 1) {
        text += sentence(i);
        if (i === boundary) {
          // the marker group sits between sentence i and sentence i + 1 (the gaps and decoration around it are the thing under test)
          text += `${pick(gapBefore)}${pick(before)}[2]${pick(after)}${pick(gapAfter)}`;
        } else if (i < count - 1) {
          text += cjk ? pick(['', ' ']) : pick([' ', '\n']);
        }
      }
      const out = removeClaims(text, new Set([2])).body;
      const ctx = JSON.stringify({ text, out });
      const has = (i: number): boolean => new RegExp(`Tok${String(round * 10 + i)}(?!\\d)`).test(out);
      // the claim side: the sentence before the marker and the one after it are gone; no other sentence is lost (barring a soft split)
      expect(has(boundary), `the claim before the marker was kept: ${ctx}`).toBe(false);
      expect(has(boundary + 1), `the sentence after the marker was kept: ${ctx}`).toBe(false);
      // (a `?` or `!` before a sentence is a doubtful split: a claim that is taken takes the sentence before it, and so on back to a full stop)
      const mayGo = new Set<number>();
      for (let j = boundary; j > 0 && stopOf[j - 1] !== '.' && stopOf[j - 1] !== '。'; j -= 1) mayGo.add(j - 1);
      for (let i = 0; i < count; i += 1) {
        if (i !== boundary && i !== boundary + 1 && !mayGo.has(i)) expect(has(i), `an unrelated sentence ${String(i)} was lost: ${ctx}`).toBe(true);
      }
      // and the reader's side: no marker 2 is drawn
      expect(renderedMarkers(out), ctx).not.toContain(2);
    }
  });
});
