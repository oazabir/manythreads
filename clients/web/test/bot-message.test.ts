import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AnswerPayloadView } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { Answer, answeredForLine, answeredForRaw, sourcesLabel } from '../src/channels/Answer';
import { authorMark } from '../src/channels/authorMark';

// P21-07: a bot's reply reads as a message. The pure parts: the Bot tag, the footer in words, the card only with sources, the closed Sources line and its count.

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const who = (over: Record<string, unknown> = {}) => ({ personId: uuid(1), name: 'Nadia', scope: 'scoped' as const, alias: null, botId: uuid(2), runId: uuid(3), ...over }) as never;

describe('authorMark', () => {
  it('tags a bot "Bot", not a person', () => {
    expect(authorMark({ kind: 'bot' })).toEqual({ label: 'Bot', title: 'A bot, not a person' });
  });
  it('leaves a person, a missing author and a bare system author untagged', () => {
    expect(authorMark({ kind: 'person' })).toBeNull();
    expect(authorMark(null)).toBeNull();
    expect(authorMark(undefined)).toBeNull();
    expect(authorMark({ kind: 'system' })).toBeNull();
  });
  it('keeps Webhook and System for the senders that are not bots', () => {
    expect(authorMark({ kind: 'system', sender: 'webhook' })?.label).toBe('Webhook');
    expect(authorMark({ kind: 'system', sender: 'reminders' })?.label).toBe('System');
  });
});

describe('the footer in words', () => {
  it('says "your private notes" only to the person it was for', () => {
    expect(answeredForLine(who(), uuid(1))).toBe('Used your private notes');
    expect(answeredForLine(who(), uuid(9))).toBe('Used Nadia’s own access');
    expect(answeredForLine(who(), null)).toBe('Used Nadia’s own access');
  });
  it('names the team’s sources for team scope and for a run nobody asked', () => {
    expect(answeredForLine(who({ scope: 'team', personId: null, name: null }))).toBe('Used the team’s sources');
    expect(answeredForLine(who({ scope: 'team' }), uuid(1))).toBe('Used the team’s sources');
    expect(answeredForLine(who({ personId: null, name: null }))).toBe('Used the team’s sources');
  });
  it('falls back to "the asker" for a person with no name', () => {
    expect(answeredForLine(who({ name: null }), uuid(9))).toBe('Used the asker’s own access');
  });
  it('puts the model in words: fast, smart, and any other alias as "<alias> model"', () => {
    expect(answeredForLine(who({ alias: 'fast' }))).toBe('Used Nadia’s own access · fast model');
    expect(answeredForLine(who({ alias: 'smart' }), uuid(1))).toBe('Used your private notes · smart model');
    expect(answeredForLine(who({ alias: 'sonnet' }))).toBe('Used Nadia’s own access · sonnet model');
  });
  it('keeps the raw line for the tooltip', () => {
    expect(answeredForRaw(who({ alias: 'smart' }))).toBe('Answered for Nadia · scoped · smart');
    expect(answeredForRaw(who({ scope: 'team', personId: null, name: null }))).toBe('Answered for the team · team');
  });
});

const payload = (over: Record<string, unknown> = {}) =>
  AnswerPayloadView.parse({
    version: 1,
    body: 'The deploy waits [1].',
    citations: [],
    lineage: [],
    sourcesReached: [],
    outsideScope: { count: 0, items: [] },
    answeredFor: { personId: uuid(1), name: 'Nadia', scope: 'scoped', alias: null, botId: uuid(2), runId: uuid(3) },
    chips: [],
    ...over,
  });
const cite = (n: number) => ({ kind: 'page', n, label: `pages/p${String(n)}.md`, scope: 'team', teamId: uuid(12), path: `pages/p${String(n)}.md` });
const html = (p: AnswerPayloadView): string => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Answer, { payload: p, teamSlug: 'engineering' })));

describe('card or plain text', () => {
  it('is plain text with no citations, and still carries the answer test id', () => {
    const out = html(payload());
    expect(out).toContain('data-testid="answer"');
    expect(out).toContain('an-plain');
    expect(out).not.toContain('an-card');
    expect(out).not.toContain('data-testid="answer-sources"');
  });
  it('is a card as soon as there is one citation, with the citations listed outside the Sources line', () => {
    const out = html(payload({ citations: [cite(1)] }));
    expect(out).toContain('an-card');
    expect(out).not.toContain('an-plain');
    expect(out).toContain('data-testid="answer-citations"');
    expect(out.indexOf('data-testid="answer-citations"')).toBeLessThan(out.indexOf('<details') === -1 ? Infinity : out.indexOf('<details'));
  });
});

describe('the Sources line', () => {
  const lineage = [{ n: 1, kind: 'page', label: 'pages/p1.md', at: null, snippet: null }, { n: 2, kind: 'page', label: 'pages/p2.md', at: null, snippet: null }];
  const reached = [{ kind: 'page', ref: 'pages/p1.md', label: 'pages/p1.md', marker: 'full' }];
  it('is closed by default and holds lineage, reached and outside scope', () => {
    const out = html(payload({ citations: [cite(1)], lineage, sourcesReached: reached, outsideScope: { count: 1, items: [{ kind: 'message', reason: 'not_visible', count: 1 }] } }));
    const details = /<details[^>]*data-testid="answer-sources"[^>]*>/.exec(out)?.[0] ?? '';
    expect(details).not.toBe('');
    expect(details).not.toContain('open');
    const inside = out.slice(out.indexOf(details), out.indexOf('</details>'));
    for (const id of ['answer-lineage', 'answer-reached', 'answer-outside']) expect(inside).toContain(`data-testid="${id}"`);
  });
  it('counts the citations when there are some', () => {
    expect(html(payload({ citations: [cite(1), cite(2)], lineage }))).toContain('<summary>Sources (2)</summary>');
  });
  it('counts what was read (lineage and reached) when nothing is cited', () => {
    expect(html(payload({ lineage, sourcesReached: reached }))).toContain('<summary>Sources (3)</summary>');
  });
  it('is not drawn when there is nothing to put under it', () => {
    expect(html(payload({ citations: [cite(1)] }))).not.toContain('<details');
  });
  it('words the label from the two counts', () => {
    expect(sourcesLabel(2, 5)).toBe('Sources (2)');
    expect(sourcesLabel(0, 3)).toBe('Sources (3)');
    expect(sourcesLabel(0, 0)).toBe('Sources');
  });
  it('is drawn for outside scope alone', () => {
    expect(html(payload({ outsideScope: { count: 2, items: [{ kind: 'message', reason: 'not_visible', count: 2 }] } }))).toContain('<summary>Sources</summary>');
  });
});
