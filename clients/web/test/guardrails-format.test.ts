import { describe, expect, it } from 'vitest';
import { DlpDetectorSetting, DlpRuleSetting, SetTeamEgressRequest, TestDlpRequest, type TestDlpResponse } from '@manythreads/shared';
import { DETECTOR_ACTION_HINTS, DETECTOR_ACTION_LABELS, RULE_ACTION_LABELS, hostsFromText, hostsToText, proxyFromText, teamEgressSummary, testOutcomeWords } from '../src/screens/guardrails/format';

describe('data protection words', () => {
  it('names every setting the server accepts, and nothing else', () => {
    expect(Object.keys(DETECTOR_ACTION_LABELS).sort()).toEqual([...DlpDetectorSetting.options].sort());
    expect(Object.keys(DETECTOR_ACTION_HINTS).sort()).toEqual([...DlpDetectorSetting.options].sort());
    expect(Object.keys(RULE_ACTION_LABELS).sort()).toEqual([...DlpRuleSetting.options].sort());
  });

  it('says what a test found without repeating the text', () => {
    const base = { text: 'x' } as const;
    const redact: TestDlpResponse = { ...base, outcome: 'redact', findings: [{ rule: 'api-key', count: 2 }] };
    expect(testOutcomeWords(redact)).toBe('Found api-key (2). The text would go on with each match replaced by a marker.');
    expect(testOutcomeWords({ ...base, outcome: 'allow', findings: [] })).toContain('Nothing was found');
    expect(testOutcomeWords({ ...base, outcome: 'block', findings: [{ rule: 'card-number', count: 1 }] })).toContain('stopped');
    expect(testOutcomeWords({ ...base, outcome: 'require_approval', findings: [{ rule: 'iban', count: 1 }] })).toContain('approve');
    expect(testOutcomeWords({ ...base, outcome: 'allow', findings: [{ rule: 'email-address', count: 1 }] })).toContain('lets it through');
  });
});

describe('hosts typed into the box', () => {
  it('splits on lines, commas and spaces, and drops blanks and repeats', () => {
    expect(hostsFromText('a.example.com\n b.example.com,c.example.com  a.example.com\n\n')).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
    expect(hostsFromText('')).toEqual([]);
    expect(hostsToText(['a.example.com', 'b.example.com'])).toBe('a.example.com\nb.example.com');
  });

  it('turns a blank proxy into none', () => {
    expect(proxyFromText('  ')).toBeNull();
    expect(proxyFromText(' http://proxy.internal:3128 ')).toBe('http://proxy.internal:3128');
  });

  it('summarizes a team in words', () => {
    expect(teamEgressSummary(false, 0)).toBe('No limit set');
    expect(teamEgressSummary(false, 2)).toBe('Not limiting (2 saved)');
    expect(teamEgressSummary(true, 0)).toBe('Limited to the workspace list');
    expect(teamEgressSummary(true, 1)).toBe('Limited to 1 host and the workspace list');
  });
});

describe('what the screen sends is what the server accepts', () => {
  it('a proxy with a password in it is refused before it is sent', () => {
    expect(SetTeamEgressRequest.safeParse({ enforce: true, hosts: [], proxyUrl: 'http://user:pass@proxy.internal:3128' }).success).toBe(false);
    expect(SetTeamEgressRequest.safeParse({ enforce: true, hosts: [], proxyUrl: 'ftp://proxy.internal' }).success).toBe(false);
    expect(SetTeamEgressRequest.safeParse({ enforce: true, hosts: ['a.example.com'], proxyUrl: 'http://proxy.internal:3128' }).success).toBe(true);
    expect(SetTeamEgressRequest.safeParse({ enforce: false, hosts: [], proxyUrl: null }).success).toBe(true);
  });

  it('the test box request carries a text and an optional unsaved pattern', () => {
    expect(TestDlpRequest.parse({ text: 'hello' })).toMatchObject({ preset: 'standard' });
    expect(TestDlpRequest.safeParse({ text: 'x', rule: { pattern: 'CUST-[0-9]{6}' } }).success).toBe(true);
    expect(TestDlpRequest.safeParse({ text: 'x'.repeat(20_001) }).success).toBe(false);
  });
});
