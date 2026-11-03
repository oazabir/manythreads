import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AnswerComponent, AnswerPayload, AnswerPayloadView, SURFACE_REGISTRY } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { Answer } from '../src/channels/Answer';
import { AnswerSurface } from '../src/surfaces/answerView';
import { SurfaceHostContext } from '../src/surfaces/host';
import { Surface } from '../src/surfaces/Surface';
import { SURFACE_VIEWS } from '../src/surfaces/views';

// The Answer as a registered surface part (PLAN P9-07): one drawing, reached through the registry, that looks the same wherever a stored answer is read.

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const base = {
  version: 1,
  body: 'Review and tests are green [1]; the deploy waits for the window [2].',
  citations: [
    { kind: 'message', n: 1, label: 'Tester: 213 passing', scope: 'team', messageId: uuid(10), channelId: uuid(11), teamId: uuid(12), channelKind: 'channel', channelName: 'release-eng', threadRootId: null },
    { kind: 'page', n: 2, label: 'pages/specs/schedule.md', scope: 'team', teamId: uuid(12), path: 'pages/specs/schedule.md' },
  ],
  lineage: [{ n: 1, kind: 'message', label: 'Tester: 213 passing', at: '2026-01-01T00:00:00.000Z', snippet: '213 passing. Ready.' }],
  sourcesReached: [{ kind: 'message', ref: uuid(10), label: 'Tester: 213 passing', marker: 'full' }],
  outsideScope: { count: 1, items: [{ kind: 'message', reason: 'not_visible', count: 1 }] },
  answeredFor: { personId: uuid(20), name: 'Omar', scope: 'scoped', alias: 'smart', botId: uuid(21), runId: uuid(22) },
  chips: [
    { kind: 'followup', label: 'Why is it waiting?', prompt: 'Why is the deploy waiting?' },
    { kind: 'handoff', botId: uuid(23), botSlug: 'coder', botName: 'Coder' },
  ],
};
const stored = AnswerPayload.parse(base);
const teamSlugOf = (id: string): string | null => (id === uuid(12) ? 'engineering' : null);
const inRouter = (el: ReturnType<typeof createElement>): string => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const direct = (p: AnswerPayloadView): string => inRouter(createElement(Answer, { payload: p, teamSlug: 'engineering', teamSlugOf }));
const registered = (p: AnswerPayloadView, onChip?: () => void): string =>
  inRouter(createElement(AnswerSurface, { payload: p, teamSlug: 'engineering', teamSlugOf, ...(onChip ? { onChip } : {}) }));

/** The answer written the way a bot writes a part: its values by position, in the order the registry lists. */
const asSurface = (p: AnswerPayload): string => {
  const values = AnswerComponent.args.map((a) => JSON.stringify((p as Record<string, unknown>)[a] ?? null));
  return `root = Answer(${values.join(', ')})\n`;
};

describe('Answer is a registered part', () => {
  it('is in the registry with the stored AnswerPayload as its values, and has a drawing', () => {
    expect(SURFACE_REGISTRY.has('Answer')).toBe(true);
    expect(AnswerComponent.props).toBe(AnswerPayload);
    expect(SURFACE_VIEWS.has('Answer')).toBe(true);
    expect([...AnswerComponent.args].sort()).toEqual(Object.keys(AnswerPayload.shape).sort());
  });

  it('draws a stored answer exactly as the one Answer drawing does (an unsupported source from a newer server included)', () => {
    expect(registered(stored)).toBe(direct(stored));
    const newer = AnswerPayloadView.parse({ ...base, citations: [...base.citations, { kind: 'futurekind', n: 3, label: 'later', scope: 'team' }] });
    expect(registered(newer)).toBe(direct(newer));
    expect(registered(newer)).toContain('Unsupported source');
  });

  it('draws the same in a channel thread (chips inert) and in a conversation (chips act): same text, same sources, same layout', () => {
    const thread = registered(stored);
    const conversation = registered(stored, () => undefined);
    // the only difference is a chip being a button that acts instead of a plain label
    const plain = (html: string): string => html.replace(/<button type="button"/g, '<span').replace(/<\/button>/g, '</span>');
    expect(plain(conversation)).toBe(thread);
    expect(thread).toContain('data-testid="answer-citations"');
    expect(conversation).toContain('<button type="button" class="an-chip"');
  });

  it('a bot-drawn surface with an Answer in it gets the "not available" card, never the answer (the page lends no `answer`)', () => {
    const out = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Surface, { source: asSurface(stored), ended: true })));
    expect(out).toContain('data-testid="surface-rejection"');
    expect(out).toContain('data-code="unknown_component"');
    expect(out).toContain('This part is not available');
    expect(out).toContain('Answer is drawn only by the platform');
    expect(out).not.toContain('data-testid="answer"');
    expect(out).not.toContain('Answered for');
  });

  it('a page that lends `answer` (the app\'s own message) draws the checked part as the stored message', () => {
    const host = { answer: { teamSlug: 'engineering', teamSlugOf } };
    const out = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(SurfaceHostContext.Provider, { value: host }, createElement(Surface, { source: asSurface(stored), ended: true }))),
    );
    expect(out).not.toContain('surface-rejection');
    expect(out).toContain(direct(stored));
  });

  it('a surface Answer with values that are not an answer is a card in its place', () => {
    const out = renderToStaticMarkup(createElement(Surface, { source: 'root = Answer(2, "x")\n', ended: true }));
    expect(out).toContain('surface-rejection');
    expect(out).toContain('data-code="invalid_props"');
  });
});
