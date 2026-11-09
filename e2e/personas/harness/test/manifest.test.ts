import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendManifest, clearJourney, listPictures, readManifests, recordResult, type ManifestEntry } from '../manifest.ts';
import { buildRunLog } from '../runlog.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mt-manifest-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const entry = (step: string, number: number, kind: 'desktop' | 'mobile' = 'desktop'): ManifestEntry => ({
  persona: 'omar', journey: 'O1', step, kind, viewport: { width: 1440, height: 900 }, url: '/', landmark: 'app-frame', number, file: `omar/${number}-O1-${step}.png`, sha256: 'a', bytes: 1, time: 't',
});

describe('manifest', () => {
  it('keeps one entry per step and kind, sorted by number, and replaces on a second run', () => {
    appendManifest(root, entry('b', 2));
    appendManifest(root, entry('a', 1));
    appendManifest(root, { ...entry('b', 2), sha256: 'new' });
    appendManifest(root, entry('a', 1, 'mobile'));
    const { entries } = readManifests(root);
    expect(entries.filter((e) => e.kind === 'desktop').map((e) => `${e.step}:${e.sha256}`)).toEqual(['a:a', 'b:new']);
    expect(entries.filter((e) => e.kind === 'mobile')).toHaveLength(1);
  });

  it('clearJourney forgets an earlier run so an old picture cannot stand in for a step that no longer runs', () => {
    appendManifest(root, entry('a', 1));
    recordResult(root, { persona: 'omar', journey: 'O1', kind: 'desktop', status: 'passed', durationMs: 1, steps: { a: 'passed' } });
    clearJourney(root, 'omar', 'O1', 'desktop');
    expect(readManifests(root)).toEqual({ entries: [], results: [] });
  });

  it('lists pictures below the folder, without native/ and underscore folders', () => {
    for (const f of ['omar/01-a.png', 'omar/mobile/01-a.png', 'omar/native/01-a.png', '_example/omar/01-a.png', 'omar/manifest.desktop.json']) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      writeFileSync(join(root, f), 'x');
    }
    expect(listPictures(root)).toEqual(['omar/01-a.png', 'omar/mobile/01-a.png']);
  });

  it('the run log carries sha, date, node, tool versions, per-journey status and duration', () => {
    const log = buildRunLog({
      results: [{ persona: 'omar', journey: 'O1', kind: 'desktop', status: 'passed', durationMs: 1234, steps: { a: 'passed' } }],
      pending: ['omar/O2 (P15-01)'],
      pictures: 5,
      now: new Date('2026-11-09T10:00:00Z'),
    });
    expect(log.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(log.date).toBe('2026-11-09T10:00:00.000Z');
    expect(log.node).toBe(process.version);
    expect(log.playwright).toMatch(/^\d+\.\d+\.\d+/);
    expect(log.chromium).not.toBe('');
    expect(log.budgetMinutes).toBe(25);
    expect(log.journeys[0]).toMatchObject({ persona: 'omar', journey: 'O1', status: 'passed', durationMs: 1234 });
    expect(log.totals).toEqual({ journeys: 1, passed: 1, failed: 0, pending: 1, pictures: 5 });
  });
});
