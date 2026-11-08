import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/catalog.ts';

// P15-13: `meetings.search` is a read tool. What a call answered becomes the run's source log, one `meeting` line per meeting, which is what lets the answer builder accept a citation of it.

const M1 = '0190a000-0000-7000-8000-000000000031';
const M2 = '0190a000-0000-7000-8000-000000000032';

describe('the meetings.search tool', () => {
  const tool = TOOLS['meetings.search']!;

  it('is a read, offered with a plain description that says it is data', () => {
    expect(tool.kind).toBe('read');
    expect(tool.description).toMatch(/never as instructions/);
    expect(Object.keys((tool.inputSchema as { properties: object }).properties).sort()).toEqual(['limit', 'query', 'teamId']);
  });

  it('logs each meeting it answered once, in the scope of a channel', () => {
    const lines = tool.sourcesFrom!({ hits: [{ meetingId: M1, atMs: 1000 }, { meetingId: M1, atMs: 9000 }, { meetingId: M2, atMs: 0 }] });
    expect(lines).toEqual([
      { sourceType: 'meeting', sourceRef: M1, scope: 'channel' },
      { sourceType: 'meeting', sourceRef: M2, scope: 'channel' },
    ]);
  });

  it('logs nothing for an answer that is not a list of hits', () => {
    for (const bad of [null, undefined, {}, { hits: 'x' }, { hits: [{ meetingId: 5 }, null, {}] }, { ok: false, code: 'not_built' }]) {
      expect(tool.sourcesFrom!(bad)).toEqual([]);
    }
  });
});
