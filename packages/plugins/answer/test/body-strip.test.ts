import { AnswerInput } from '@manythreads/shared';
import { expectLinear } from '@manythreads/test-utils/linear';
import { describe, expect, it } from 'vitest';
import { buildAnswer, withoutSourceLines } from '../src/build.ts';
import type { AnswerView } from '../src/view.ts';

// P21-F: the model sometimes ends an answer with its own "Citation: ..." line. The citations are drawn from the payload, so that line is a second, unchecked list.
// buildAnswer drops such lines when the answer carries citations, and only then.

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const RUN: AnswerView['run'] = {
  runId: uuid(1), botId: uuid(2), botName: 'Brain', botSlug: 'brain', alias: 'smart', teamId: uuid(3), workspaceId: uuid(4), trigger: 'conversation',
  hasAsker: true, askerPersonId: uuid(5), askerName: 'Nadia', channelId: uuid(6), replyRootId: uuid(7), private: true,
};
const seen = { found: true, scope: 'team' as const, audience: true, label: 'A readable message', at: '2026-10-01T12:00:00.000Z', channelId: uuid(20), channelKind: 'channel' as const, channelName: 'dev', threadRootId: null };
const withCitation = (body: string, kept = true) =>
  buildAnswer(AnswerInput.parse({ body, citations: [{ kind: 'message', messageId: uuid(10) }] }), { run: RUN, citations: [kept ? seen : { found: false }], sources: [], bots: [] }).payload.body;

describe('withoutSourceLines', () => {
  it.each([
    ['Citation: [1]', 'Citation:'],
    ['citations: [1], [2]', 'Citations:'],
    ['SOURCES: the release note', 'Sources:'],
    ['  Citation: indented', 'indented'],
    ['**Citation:** [1]', 'markdown bold'],
    ['> Sources: quoted', 'quoted'],
    ['- Citation: in a list', 'list'],
  ])('drops the line %s (%s)', (line) => {
    expect(withoutSourceLines(`The release is on Friday [1].\n${line}\nAnything else?`)).toBe('The release is on Friday [1].\nAnything else?');
  });

  it('drops a closing line and the blank line before it', () => {
    expect(withoutSourceLines('The release is on Friday [1].\n\nCitation: [1]')).toBe('The release is on Friday [1].');
  });

  it('keeps lines that only mention the words, and a body that is nothing else', () => {
    const body = 'A good citation: is rare.\nThe sources: are listed below [1].\nCited by Omar.';
    expect(withoutSourceLines(body)).toBe(body);
    expect(withoutSourceLines('Citation: [1]')).toBe('Citation: [1]');
  });

  it('is linear on hostile input: many markup characters, many blank lines, a very long line', () => {
    const make = (n: number) => `${'*_> -#'.repeat(n)}Citation:\n${'\n'.repeat(n * 6)}${' '.repeat(n * 6)}Sources: x\n${'a'.repeat(n * 6)}`;
    expectLinear(make, (body) => withoutSourceLines(body), { n: 4000, factor: 2, ceilingMs: 1000, label: 'stripping source lines' });
  });
});

describe('buildAnswer and the Citation: line', () => {
  const body = 'Three threads need a reply [1].\n\nCitation: [1]';
  it('strips it when the answer carries a citation', () => {
    expect(withCitation(body)).toBe('Three threads need a reply [1].');
  });
  it('leaves the body alone when every citation was dropped (nothing else lists the sources)', () => {
    expect(withCitation(body, false)).toBe(body);
  });
  it('leaves the body alone when the bot sent no citation', () => {
    const plain = buildAnswer(AnswerInput.parse({ body }), { run: RUN, citations: [], sources: [], bots: [] }).payload.body;
    expect(plain).toBe(body);
  });
});
