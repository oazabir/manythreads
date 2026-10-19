import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AnswerPayloadView, type AnswerCitation } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { Answer, answeredForLine, citationTarget, kindCount } from '../src/channels/Answer';

// The Answer component (PLAN P5-18, `[proto §12]` plate 2): what is drawn for a payload, and what a link from it opens.

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const message = (over: Record<string, unknown> = {}) => ({
  kind: 'message',
  n: 1,
  label: 'Tester: 213 passing at f07b3d9',
  scope: 'team',
  messageId: uuid(10),
  channelId: uuid(11),
  teamId: uuid(12),
  channelKind: 'channel',
  channelName: 'release-eng',
  threadRootId: null,
  ...over,
});

const payload = (over: Record<string, unknown> = {}) =>
  AnswerPayloadView.parse({
    version: 1,
    body: 'Review and tests are green [1]; the deploy waits for the window [2]. Your plan doc says otherwise [3] and a note [4].',
    citations: [
      message(),
      { kind: 'page', n: 2, label: 'pages/specs/schedule-migration.md', scope: 'team', teamId: uuid(12), path: 'pages/specs/schedule-migration.md' },
      { kind: 'file', n: 3, label: 'migration-plan.pdf', scope: 'channel', fileId: uuid(13) },
      { kind: 'futurekind', n: 4, label: 'unknown source', scope: 'team' },
    ],
    lineage: [
      { n: 1, kind: 'message', label: 'Tester: 213 passing at f07b3d9', at: new Date(Date.now() - 4 * 3_600_000).toISOString(), snippet: '213 passing at f07b3d9. Ready.' },
      { n: 2, kind: 'page', label: 'pages/specs/schedule-migration.md', at: null, snippet: null },
    ],
    sourcesReached: [
      { kind: 'message', ref: uuid(10), label: 'Tester: 213 passing at f07b3d9', marker: 'full' },
      { kind: 'drive', ref: 'doc-1', label: null, marker: 'scoped' },
    ],
    outsideScope: {
      count: 3,
      items: [
        { kind: 'message', reason: 'not_visible', count: 2 },
        { kind: 'memory', reason: 'not_granted', count: 1 },
      ],
    },
    answeredFor: { personId: uuid(20), name: 'Omar', scope: 'scoped', alias: 'smart', botId: uuid(21), runId: uuid(22) },
    chips: [
      { kind: 'followup', label: 'Why is it waiting?', prompt: 'Why is the deploy waiting for the window?' },
      { kind: 'handoff', botId: uuid(23), botSlug: 'coder', botName: 'Coder' },
    ],
    ...over,
  });

const html = (p = payload()): string => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Answer, { payload: p, teamSlug: 'engineering', teamSlugOf: (id) => (id === uuid(12) ? 'engineering' : null) })));

describe('the Answer', () => {
  it('draws the text with each [n] as the number of its source, linked when the source is open and muted when it is not', () => {
    const out = html();
    // a message citation opens the channel at the message
    expect(out).toContain('<sup class="an-ref"><a');
    expect(out).toContain('href="/t/engineering/c/release-eng?message=');
    expect(out).toContain('aria-label="Source 1: Tester: 213 passing at f07b3d9"');
    // a page opens in Files, a file downloads
    expect(out).toContain('href="/t/engineering/files?open=pages%2Fspecs%2Fschedule-migration.md"');
    expect(out).toContain('href="/api/files/');
    // a number the answer cites that is not among its citations is drawn muted, not as a link
    expect(out).not.toContain('[1]');
    expect(out).toContain('an-ref an-ref-gone');
  });

  it('turns only the answer’s own numbers into markers: an array index or a number beyond its last citation stays text', () => {
    const p = payload({ body: 'The slot is arr[0] and the table has [12] rows; the deploy waits [1].', citations: [message()], lineage: [], sourcesReached: [], outsideScope: { count: 0, items: [] }, chips: [] });
    const out = html(p);
    expect(out).toContain('arr[0]');
    expect(out).toContain('[12]');
    expect(out.match(/data-testid="answer-marker"/g)).toHaveLength(1);
    // a citation the answer left out keeps its number, muted, when a later one was kept
    const gap = html(payload({ body: 'See [1] and [2].', citations: [message({ n: 2 })], lineage: [], sourcesReached: [], outsideScope: { count: 0, items: [] }, chips: [] }));
    expect(gap).toContain('an-ref an-ref-gone');
    expect(gap).not.toContain('[1]');
  });

  it('marks the quoted words for the visual diff, keeps headings out of the message, and labels links only', () => {
    const out = html();
    expect(out).toMatch(/class="an-sn" data-vt-mask/);
    expect(out).not.toContain('<h5');
    // an unsupported source is a span with no aria-label of its own (a label on a non-interactive element is not read)
    expect(out).not.toMatch(/<span[^>]*aria-label=/);
  });

  it('lists the numbered citations as chips, with a neutral chip for a kind it does not know', () => {
    const out = html();
    expect(out.match(/data-testid="answer-citation"/g)).toHaveLength(4);
    expect(out).toContain('an-cite an-cite-unsupported');
    expect(out).toContain('Unsupported source');
    // never the raw fields of what it could not read
    expect(out).not.toContain('memory/facts/window.md');
  });

  it('shows the lineage with age and the quoted words, what was reached with the asker’s own connection marked, and what was outside scope', () => {
    const out = html();
    expect(out).toContain('data-testid="answer-lineage"');
    expect(out).toContain('“213 passing at f07b3d9. Ready.”');
    expect(out).toMatch(/<span class="an-age"[^>]*>4h<\/span>/);
    expect(out).toMatch(/class="an-age" data-vt-mask/);
    expect(out).toContain('data-testid="answer-reached"');
    expect(out).toContain('an-dot scoped');
    expect(out).toContain('through the asker’s own connection');
    expect(out).toContain('data-testid="answer-outside"');
    expect(out).toContain('2 messages · not visible to the person who asked');
    expect(out).toContain('1 memory item · not granted to this bot');
    expect(html(payload({ outsideScope: { count: 1, items: [{ kind: 'message', reason: 'not_reached', count: 1 }] } }))).toContain('1 message · not read by this bot in this run');
  });

  it('says whom it was for, how it was scoped and on which alias, and offers the bots it may be handed to', () => {
    const out = html();
    expect(out).toContain('Answered for Omar · scoped · smart');
    expect(out).toContain('Hand to a bot');
    expect(out).toContain('@Coder');
    expect(out).toContain('Why is it waiting?');
    // the chips are data in this version: inert, not buttons
    expect(out).not.toMatch(/<button[^>]*an-chip/);
  });

  it('leaves out the sections that have nothing: no lineage, reached, outside scope or chips for a plain answer', () => {
    const out = html(payload({ citations: [], lineage: [], sourcesReached: [], outsideScope: { count: 0, items: [] }, chips: [], body: 'Just an answer.' }));
    for (const id of ['answer-lineage', 'answer-reached', 'answer-outside', 'answer-chips', 'answer-citations']) expect(out).not.toContain(`data-testid="${id}"`);
    expect(out).toContain('Answered for Omar');
    expect(out).toContain('Just an answer.');
  });

  it('calls a run nobody asked the team’s', () => {
    const p = payload({ answeredFor: { personId: null, name: null, scope: 'team', alias: null, botId: uuid(21), runId: uuid(22) } });
    expect(html(p)).toContain('Answered for the team · team');
  });

  it('never turns text into markup: a body and a label with tags stay characters', () => {
    const p = payload({
      body: '<img src=x onerror=alert(1)> [1]',
      citations: [message({ label: '<script>alert(1)</script>' })],
      lineage: [],
    });
    const out = html(p);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script>alert');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('draws a body full of markers in linear time', () => {
    // the same hostile construction at n and at 4n, best of a few runs each: the cost must grow about 4x, never 16x (and stay far from a blow-up)
    const make = (n: number) => payload({ body: '[1] x '.repeat(n), citations: [message()], lineage: [], sourcesReached: [], outsideScope: { count: 0, items: [] }, chips: [] });
    const best = (p: ReturnType<typeof make>): number => {
      let out = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        html(p);
        out = Math.min(out, performance.now() - started);
      }
      return out;
    };
    const small = make(500);
    const large = make(2000);
    html(small);
    html(large);
    const smallMs = best(small);
    const largeMs = best(large);
    expect(smallMs).toBeLessThan(2_000);
    expect(largeMs).toBeLessThan(8_000);
    expect(largeMs / Math.max(smallMs, 20)).toBeLessThan(10);
  });
});

describe('where a citation opens', () => {
  const slugOf = (id: string): string | null => (id === uuid(12) ? 'engineering' : id === uuid(30) ? 'marketing' : null);
  const cite = (c: Record<string, unknown>): AnswerCitation => payload({ citations: [c], lineage: [] }).citations[0] as AnswerCitation;

  it('opens a message in its channel, a reply in its thread, and a conversation in the conversation view', () => {
    expect(citationTarget(cite(message()), 'engineering', slugOf)).toMatchObject({
      type: 'route',
      pathname: '/t/engineering/c/release-eng',
      search: expect.stringContaining('?message=' + uuid(10)) as string,
    });
    const reply = citationTarget(cite(message({ threadRootId: uuid(40) })), 'engineering', slugOf);
    expect(reply).toMatchObject({ type: 'route', pathname: '/t/engineering/c/release-eng' });
    expect(JSON.stringify(reply)).toContain(uuid(40));
    expect(citationTarget(cite(message({ channelKind: 'bot_conversation', channelName: null })), 'engineering', slugOf)).toMatchObject({
      type: 'route',
      pathname: `/t/engineering/chat/${uuid(11)}`,
      search: `?thread=${uuid(10)}`,
    });
    expect(citationTarget(cite(message({ channelKind: 'dm', channelName: null })), 'engineering', slugOf)).toMatchObject({ pathname: `/t/engineering/dm/${uuid(11)}` });
  });

  it('opens a message of another team under that team’s address, not the page’s own', () => {
    expect(citationTarget(cite(message({ teamId: uuid(30), channelName: 'launch' })), 'engineering', slugOf)).toMatchObject({ pathname: '/t/marketing/c/launch' });
    expect(citationTarget(cite({ kind: 'thread', n: 1, label: 't', scope: 'team', threadRootId: uuid(10), channelId: uuid(11), teamId: uuid(30), channelKind: 'channel', channelName: 'launch' }), 'engineering', slugOf)).toMatchObject({
      pathname: '/t/marketing/c/launch',
    });
    // a team the reader does not know (or a DM, which has none) falls back to the page's own
    expect(citationTarget(cite(message({ teamId: uuid(99) })), 'engineering', slugOf)).toMatchObject({ pathname: '/t/engineering/c/release-eng' });
    expect(citationTarget(cite(message({ teamId: null, channelKind: 'dm', channelName: null })), 'engineering', slugOf)).toMatchObject({ pathname: `/t/engineering/dm/${uuid(11)}` });
  });

  it('opens a thread, a page of its own team, a file and the bot of a run', () => {
    expect(citationTarget(cite({ kind: 'thread', n: 1, label: 't', scope: 'team', threadRootId: uuid(10), channelId: uuid(11), teamId: uuid(12), channelKind: 'channel', channelName: 'dev' }), 'engineering', slugOf)).toMatchObject({
      type: 'route',
      pathname: '/t/engineering/c/dev',
    });
    expect(citationTarget(cite({ kind: 'page', n: 1, label: 'p', scope: 'team', teamId: uuid(30), path: 'pages/plan.md' }), 'engineering', slugOf)).toEqual({
      type: 'route',
      pathname: '/t/marketing/files',
      search: '?open=pages%2Fplan.md',
      state: null,
    });
    expect(citationTarget(cite({ kind: 'file', n: 1, label: 'f', scope: 'channel', fileId: uuid(13) }), 'engineering', slugOf)).toEqual({ type: 'download', href: `/api/files/${uuid(13)}/content` });
    expect(citationTarget(cite({ kind: 'run', n: 1, label: 'r', scope: 'team', runId: uuid(14), botId: uuid(15), botSlug: 'brain' }), 'engineering', slugOf)).toMatchObject({
      pathname: '/t/engineering/bots/brain',
      search: '?tab=audit',
    });
    expect(citationTarget(cite({ kind: 'run', n: 1, label: 'r', scope: 'team', runId: uuid(14), botId: uuid(15), botSlug: null }), 'engineering', slugOf)).toBeNull();
  });
});

describe('the words', () => {
  it('counts a kind in the singular and the plural, and has a word for a kind it does not know', () => {
    expect(kindCount('message', 1)).toBe('1 message');
    expect(kindCount('page', 2)).toBe('2 pages');
    expect(kindCount('drive', 3)).toBe('3 sources');
  });

  it('writes the foot line from whom, scope and alias', () => {
    expect(answeredForLine({ personId: null, name: 'Nadia', scope: 'scoped', alias: null, botId: uuid(1) as never, runId: uuid(2) as never })).toBe('Answered for Nadia · scoped');
  });
});
