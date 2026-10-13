import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AnswerPayloadView, AnswerSharePreview } from '@manythreads/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport, type TransportRequest } from '../src/api/client';
import { Answer, maskedLine, shareNote } from '../src/channels/Answer';
import { ShareDialogView, type ShareDialogViewProps } from '../src/channels/AnswerShare';
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
