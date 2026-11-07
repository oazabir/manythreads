import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/catalog.ts';

// P20-05: a recall that also read the asking person's own memory files that bank as a `person` source, so the retention rule (a run keeps no wider than the
// narrowest thing it read) cannot let the run's summary reach the team.

describe('memory.recall source lines', () => {
  const lines = (answer: unknown) => TOOLS['memory.recall']!.sourcesFrom!(answer);

  it('files the team bank as a team source', () => {
    expect(lines({ ok: true, bank: 'team:acme:eng' })).toEqual([{ sourceType: 'memory', sourceRef: 'bank:team:acme:eng', scope: 'team' }]);
  });

  it('files the person bank as a person source beside it', () => {
    expect(lines({ ok: true, bank: 'team:acme:eng', personBank: 'person:acme:p1' })).toEqual([
      { sourceType: 'memory', sourceRef: 'bank:team:acme:eng', scope: 'team' },
      { sourceType: 'memory', sourceRef: 'bank:person:acme:p1', scope: 'person' },
    ]);
  });

  it('files nothing for a refusal', () => {
    expect(lines({ ok: false, code: 'no_run' })).toEqual([]);
  });

  it('lets memory.write name a target and nothing else new', () => {
    const props = (TOOLS['memory.write']!.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props['target']?.enum).toEqual(['team', 'personal']);
  });
});
