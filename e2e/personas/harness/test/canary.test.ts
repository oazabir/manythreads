import { describe, expect, it } from 'vitest';
import { compareCanary } from '../canary.ts';
import type { JourneyResult } from '../manifest.ts';
import { journey, step } from './fixtures.ts';

const j = journey('omar', 'O1', [step('open', { next: { testid: 'composer' } }), step('typed', { expect: 'composer' }), step('bots', { expect: 'bots-roster' })], { viewports: ['desktop'] });
const result = (steps: JourneyResult['steps']): JourneyResult => ({ persona: 'omar', journey: 'O1', kind: 'desktop', status: 'failed', durationMs: 1, steps });

describe('compareCanary', () => {
  it('passes when exactly the message-box steps failed', () => {
    const r = compareCanary([j], [result({ open: 'failed', typed: 'failed', bots: 'passed' })]);
    expect(r.problems).toEqual([]);
    expect(r.expected).toEqual(['omar/O1/open (desktop)', 'omar/O1/typed (desktop)']);
  });

  it('fails when a message-box step still passed (the harness did not notice the missing composer)', () => {
    const r = compareCanary([j], [result({ open: 'failed', typed: 'passed', bots: 'passed' })]);
    expect(r.missed).toEqual(['omar/O1/typed (desktop)']);
    expect(r.problems[0]).toMatch(/did NOT fail these message-box steps/);
  });

  it('fails when another step failed too', () => {
    const r = compareCanary([j], [result({ open: 'failed', typed: 'failed', bots: 'failed' })]);
    expect(r.unexpected).toEqual(['omar/O1/bots (desktop)']);
  });

  it('fails when no step uses the message box, and when a journey did not run', () => {
    const none = journey('omar', 'O1', [step('bots', { expect: 'bots-roster' })], { viewports: ['desktop'] });
    expect(compareCanary([none], [result({ bots: 'passed' })]).problems[0]).toMatch(/proves nothing/);
    expect(compareCanary([j], []).problems[0]).toMatch(/did not run it/);
  });

  it('judges the phone viewport as well', () => {
    const both = journey('omar', 'O1', [step('typed', { expect: 'composer' })]);
    const r = compareCanary([both], [result({ typed: 'failed' }), { ...result({ typed: 'passed' }), kind: 'mobile' }]);
    expect(r.missed).toEqual(['omar/O1/typed (mobile)']);
  });
});
