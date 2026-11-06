import { describe, expect, it } from 'vitest';
import { ApprovalSource } from '@manythreads/shared';
import { riskClass, riskOf } from '../src/screens/approvals/risk';

describe('the risk tag of a waiting request', () => {
  it('is read from why the request waits', () => {
    expect(riskOf({ source: 'environment' })).toMatchObject({ label: 'Production', tone: 'alert' });
    expect(riskOf({ source: 'dlp' })).toMatchObject({ label: 'Sensitive data', tone: 'warn' });
    expect(riskOf({ source: 'dispatch' })).toMatchObject({ label: 'Strict hand-off', tone: 'neutral' });
    expect(riskOf({ source: 'grant' })).toMatchObject({ label: 'Needs approval', tone: 'warn' });
  });

  it('has a word, a tone and a hint for every source', () => {
    for (const source of ApprovalSource.options) {
      const risk = riskOf({ source });
      expect(risk.label.length).toBeGreaterThan(0);
      expect(risk.hint.endsWith('.')).toBe(true);
    }
  });

  it('draws red and amber with the shared chip tones and grey as a plain chip', () => {
    expect(riskClass(riskOf({ source: 'environment' }))).toBe('chip alert');
    expect(riskClass(riskOf({ source: 'grant' }))).toBe('chip warn');
    expect(riskClass(riskOf({ source: 'dispatch' }))).toBe('chip');
  });
});
