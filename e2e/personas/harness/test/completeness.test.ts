import { describe, expect, it } from 'vitest';
import { checkCompleteness } from '../completeness.ts';
import { stepRelativePath, resolvePersona, type JourneyDeclaration } from '../journey.ts';
import type { JourneyResult, ManifestEntry } from '../manifest.ts';
import { blankPng, busyPng, journey, step } from './fixtures.ts';

const j: JourneyDeclaration = journey('omar', 'O1', [step('open'), step('typed'), step('later', { pending: 'P8-19' })], { markers: ['B'], viewports: ['desktop'] });

function good(journeys: JourneyDeclaration[] = [j]) {
  const entries: ManifestEntry[] = [];
  const files: string[] = [];
  const bytes = new Map<string, Buffer>();
  for (const s of resolvePersona(journeys, 'omar')) {
    if (s.pending !== undefined) continue;
    const file = stepRelativePath(s, 'desktop');
    files.push(file);
    bytes.set(file, busyPng());
    entries.push({ persona: 'omar', journey: s.journeyId, step: s.id, kind: 'desktop', viewport: { width: 1440, height: 900 }, url: '/', landmark: s.expect, number: s.number, file, sha256: 'x', bytes: 1, time: 't' });
  }
  const results: JourneyResult[] = [{ persona: 'omar', journey: 'O1', kind: 'desktop', status: 'passed', durationMs: 1, steps: { open: 'passed', typed: 'passed', later: 'pending' } }];
  return { journeys, entries, results, files, read: (f: string) => bytes.get(f)!, bytes };
}

describe('completeness', () => {
  it('passes a complete run and lists the pending step', () => {
    const r = checkCompleteness(good());
    expect(r.problems).toEqual([]);
    expect(r.declared).toBe(2);
    expect(r.checked).toBe(2);
    expect(r.pendingList).toEqual(['omar/O1/later (P8-19)']);
  });

  it('names the step whose picture is missing from disk', () => {
    const g = good();
    const files = g.files.filter((f) => !f.includes('typed'));
    const r = checkCompleteness({ ...g, files });
    expect(r.problems).toEqual(['missing screenshot: step omar/O1/typed (desktop) has no file omar/02-O1-typed.png']);
  });

  it('names the step missing from the manifest', () => {
    const g = good();
    const r = checkCompleteness({ ...g, entries: g.entries.filter((e) => e.step !== 'open') });
    expect(r.problems.join('\n')).toMatch(/step omar\/O1\/open \(desktop\) is not in the manifest/);
  });

  it('fails a blank picture and names the step and file', () => {
    const g = good();
    g.bytes.set('omar/01-O1-open.png', blankPng());
    const r = checkCompleteness(g);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/step omar\/O1\/open \(desktop\): omar\/01-O1-open\.png:/);
  });

  it('fails a journey that did not pass, naming the failed step, and one that did not run', () => {
    const g = good();
    const failed: JourneyResult[] = [{ ...g.results[0]!, status: 'failed', steps: { open: 'passed', typed: 'failed', later: 'pending' }, error: 'boom\nmore' }];
    expect(checkCompleteness({ ...g, results: failed }).problems).toEqual(['journey omar/O1 (desktop) failed at step typed: boom']);
    expect(checkCompleteness({ ...g, results: [] }).problems).toEqual(['journey omar/O1 (desktop) has no result: it did not run']);
  });

  it('fails a picture that no declared step accounts for, and a manifest entry for a pending step', () => {
    const g = good();
    const extra = checkCompleteness({ ...g, files: [...g.files, 'omar/09-O1-ghost.png'] });
    expect(extra.problems).toEqual(['extra screenshot: omar/09-O1-ghost.png belongs to no declared step']);
    const stale = checkCompleteness({ ...g, entries: [...g.entries, { ...g.entries[0]!, step: 'later' }] });
    expect(stale.problems.join('\n')).toMatch(/entry for omar\/O1\/later .* not a declared, built step/);
  });

  it('expects both viewports by default and a mobile picture in the mobile folder', () => {
    const both = journey('omar', 'O1', [step('open')], { markers: ['B'] });
    const g = good([both]);
    const r = checkCompleteness({ ...g, results: [...g.results] });
    expect(r.problems.join('\n')).toMatch(/omar\/O1 \(mobile\) has no result/);
    expect(r.problems.join('\n')).toMatch(/omar\/mobile\/01-O1-open\.png/);
  });

  it('a pending journey needs nothing and is listed', () => {
    const p = journey('omar', 'O2', [step('x')], { pending: 'P15-01' });
    const g = good([j, p]);
    const r = checkCompleteness(g);
    expect(r.problems).toEqual([]);
    expect(r.pendingList).toContain('omar/O2 (P15-01)');
  });

  it('only judges the personas it is asked about', () => {
    const g = good();
    const other = journey('nadia', 'N1', [step('x')]);
    expect(checkCompleteness({ ...g, journeys: [...g.journeys, other], personas: ['omar'] }).problems).toEqual([]);
    expect(checkCompleteness({ ...g, journeys: [...g.journeys, other] }).problems.join('\n')).toMatch(/nadia\/N1/);
  });
});
