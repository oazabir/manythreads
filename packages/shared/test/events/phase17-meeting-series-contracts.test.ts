import { describe, expect, it } from 'vitest';
import { eventRegistry, isSeriesAgendaPath, isSeriesSlug, latestVersion, LivePagePath, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P17-05 (`pnpm test:events`): a meeting series made, changed or stopped carries ids and a time, never its title, agenda or people. And the
// one path under the platform's meetings/ that people edit: a series' agenda page, spelled exactly.

const sample = { type: 'meetings.series.changed', schemaVersion: 1, workspaceId: uuid(1), teamId: uuid(2), seriesId: uuid(3), change: 'created', changedBy: uuid(4), at: '2026-11-25T10:00:00.000Z' };

describe('meetings.series.changed', () => {
  it('is registered at version 1 and parses its payload unchanged', () => {
    expect(latestVersion('meetings.series.changed')).toBe(1);
    expect(Object.keys(eventRegistry['meetings.series.changed'])).toEqual(['1']);
    expect(parseEvent(sample)).toEqual(sample);
  });

  it('refuses a missing or malformed id, an unknown change and another version; drops a title', () => {
    for (const key of ['workspaceId', 'teamId', 'seriesId', 'changedBy', 'at'] as const) expect(() => parseEvent({ ...sample, [key]: undefined }), key).toThrow();
    expect(() => parseEvent({ ...sample, seriesId: 'x' })).toThrow();
    expect(() => parseEvent({ ...sample, change: 'deleted' })).toThrow();
    expect(() => parseEvent({ ...sample, schemaVersion: 2 })).toThrow();
    expect((parseEvent({ ...sample, title: 'Weekly sync' }) as unknown as Record<string, unknown>)['title']).toBeUndefined();
  });
});

describe('the agenda path of a series', () => {
  it('is meetings/series/<slug>/<day>-agenda.md, exactly and in lower case', () => {
    for (const ok of ['meetings/series/weekly-sync/2026-12-01-agenda.md', 'meetings/series/a/2026-12-01-agenda-2.md']) expect(isSeriesAgendaPath(ok), ok).toBe(true);
    for (const bad of [
      'meetings/series/weekly-sync/README.md',
      'meetings/series/weekly-sync/2026-12-01-agenda.md/x',
      'Meetings/series/weekly-sync/2026-12-01-agenda.md',
      'meetings/Series/weekly-sync/2026-12-01-agenda.md',
      'meetings/series/Weekly/2026-12-01-agenda.md',
      'meetings/series/-x/2026-12-01-agenda.md',
      'meetings/series/a--b/2026-12-01-agenda.md',
      'meetings/series/../2026-12-01-agenda.md',
      'meetings/series/x/2026-12-01-agenda.MD',
      'meetings/2026/12/01-1000-sync/transcript.md',
      'pages/meetings/series/x/2026-12-01-agenda.md',
    ]) expect(isSeriesAgendaPath(bad), bad).toBe(false);
    expect(isSeriesSlug('weekly-sync-2')).toBe(true);
    expect(isSeriesSlug('a'.repeat(49))).toBe(false);
  });

  it('is a live page, as a page under pages/ is; no other path under meetings/ is', () => {
    expect(LivePagePath.safeParse('meetings/series/weekly-sync/2026-12-01-agenda.md').success).toBe(true);
    expect(LivePagePath.safeParse('pages/notes/a.md').success).toBe(true);
    for (const bad of ['meetings/series/weekly-sync/README.md', 'meetings/2026/12/01-1000-sync/notes.md', 'TEAM.md', 'pages/']) expect(LivePagePath.safeParse(bad).success, bad).toBe(false);
  });
});
