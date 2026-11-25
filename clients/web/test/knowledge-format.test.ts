import { KnowledgeSyncMinutes } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { formatSize, RHYTHMS, sourceLine } from '../src/screens/bots/knowledge';
import { PERSONAL_SOURCES_INTRO, SOURCES_INTRO, SOURCE_CHOICES, knowledgeFilesHref, knowledgeFilesLabel, knowledgeFolder } from '../src/screens/knowledge/words';

// The size shown beside a document on the Knowledge tab (PLAN P8-33): bytes, then KB with one decimal under 10 KB, then MB.
describe('the size of a knowledge document', () => {
  it('reads in plain units', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(20 * 1024)).toBe('20 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

// The Sources list under a base (PLAN P8-08, P8-33): how often each source is read again, and how its last read went.
describe('the rhythm choices of a source', () => {
  it('offer only values the server accepts, once each, with "only when pressed" first', () => {
    expect(RHYTHMS[0]?.minutes).toBeNull();
    const minutes = RHYTHMS.flatMap((r) => (r.minutes === null ? [] : [r.minutes]));
    expect(new Set(minutes).size).toBe(minutes.length);
    for (const m of minutes) expect(KnowledgeSyncMinutes.safeParse(m).success, String(m)).toBe(true);
  });
});

// The shortcuts from the Knowledge screen to the folders where a team's knowledge is kept in Files (P37-03): the Files screen opens a folder by `?path=`.
describe('the links to the knowledge folders in Files', () => {
  it('open a team’s knowledge folder, or one base’s folder, in that team’s Files', () => {
    expect(knowledgeFolder()).toBe('knowledge');
    expect(knowledgeFolder('handbook')).toBe('knowledge/handbook');
    expect(knowledgeFilesHref('engineering')).toBe('/t/engineering/files?path=knowledge');
    expect(knowledgeFilesHref('engineering', 'handbook')).toBe('/t/engineering/files?path=knowledge%2Fhandbook');
  });

  it('keep the team’s address safe and name the team in the label', () => {
    expect(knowledgeFilesHref('a b', 'x')).toBe('/t/a%20b/files?path=knowledge%2Fx');
    expect(knowledgeFilesLabel('Engineering')).toBe('Open Engineering knowledge folder in Files');
  });

  it('say in plain words what a source is and what each choice does', () => {
    expect(SOURCES_INTRO).toMatch(/where Brain and the bots read from/);
    expect(SOURCE_CHOICES.map((c) => c.id)).toEqual(['upload', 'folder', 'url', 'app']);
    for (const c of SOURCE_CHOICES) expect(c.text.length).toBeGreaterThan(20);
    expect(PERSONAL_SOURCES_INTRO).toMatch(/not in Files/);
  });
});

describe('the last read of a source', () => {
  it('says why it failed, or whether it has been read', () => {
    expect(sourceLine({ lastSyncedAt: null, error: null })).toBe('Not read yet');
    expect(sourceLine({ lastSyncedAt: '2026-11-01T10:00:00.000Z', error: null })).toBe('Read');
    expect(sourceLine({ lastSyncedAt: '2026-11-01T10:00:00.000Z', error: 'The site answered with an error (404).' })).toBe('Could not be read: The site answered with an error (404).');
  });
});
