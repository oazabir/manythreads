import { describe, expect, it } from 'vitest';
import { captionProblems, checkCaptions, declaredSteps, parseCaptions, type DeclaredStep } from '../check-captions.ts';

const declared: DeclaredStep[] = [
  { persona: 'omar', journey: 'O1', step: 'open-dev' },
  { persona: 'omar', journey: 'O1', step: 'posted' },
  { persona: 'omar', journey: 'O2', step: 'later', pending: 'P8-19' },
];

const GOOD = `# captions
omar:
  O1:
    open-dev: "Omar opens the dev channel and sees the latest posts."
    posted: Omar sends a line and it appears in the list.
`;

describe('captions.yaml check', () => {
  it('accepts one good caption for every declared, non-pending step', () => {
    expect(checkCaptions(parseCaptions(GOOD), declared)).toEqual([]);
  });

  it('names a step that has no caption', () => {
    const text = GOOD.replace(/ {4}posted:.*\n/, '');
    expect(checkCaptions(parseCaptions(text), declared)).toEqual(['omar/O1/posted: no caption']);
  });

  it('refuses a caption of 26 words and accepts 25', () => {
    const words = (n: number): string => `Omar ${Array.from({ length: n - 1 }, () => 'sees').join(' ')}`;
    expect(captionProblems(words(25))).toEqual([]);
    expect(captionProblems(words(26))).toEqual(['26 words; the limit is 25']);
  });

  it('refuses past and future tense, and two sentences', () => {
    expect(captionProblems('Omar opened the dev channel.')).toEqual(['not in the present tense (“opened”)']);
    expect(captionProblems('The list was empty.')[0]).toMatch(/present tense.*was/);
    expect(captionProblems('Omar will see the list.')[0]).toMatch(/will/);
    expect(captionProblems('Omar sees the list. Then he leaves.')).toContain('more than one sentence');
    expect(captionProblems('Omar sees the left menu.')).toEqual([]);
  });

  it('refuses a caption for a pending step, an unknown step and a duplicate', () => {
    const text = `${GOOD}    nothing: Omar sees nothing.
  O2:
    later: Omar sees something later.
omar:
  O1:
    posted: Omar sends the line again.
`;
    const problems = checkCaptions(parseCaptions(text), declared);
    expect(problems.some((p) => p.includes('omar/O1/nothing') && p.includes('no such step'))).toBe(true);
    expect(problems.some((p) => p.includes('omar/O2/later') && p.includes('pending'))).toBe(true);
    expect(problems.some((p) => p.includes('omar/O1/posted') && p.includes('twice'))).toBe(true);
  });

  it('reports a line it cannot read with its number', () => {
    const parsed = parseCaptions('omar:\n  O1:\n   open-dev: "x"\n');
    expect(parsed.errors[0]).toMatch(/line 3/);
    expect(parseCaptions('omar:\n  O1:\n    a: "never closed\n').errors[0]).toMatch(/line 3.*not closed/);
  });

  it('reads the steps of the harness example journey', async () => {
    const steps = await declaredSteps('example');
    expect(steps.map((s) => `${s.persona}/${s.journey}/${s.step}`)).toEqual([
      'omar/O1/open-dev',
      'omar/O1/typed',
      'omar/O1/posted',
      'omar/O1/bots',
      'omar/O1/approvals',
    ]);
  });
});
