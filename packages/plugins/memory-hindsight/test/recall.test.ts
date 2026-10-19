import type { MemoryHit } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { matchesFilters, recallFact } from '../src/tools.ts';

// What `memory.recall` answers with after P5-26: a concept's OKF provenance next to the engine's own fields, and the filters a caller asks for
// (`tags`, `types`, `includeDeprecated`) applied to what the engine returned. Pure: the handler feeds these the same hits the engine would.

const hit = (over: Partial<MemoryHit> = {}): MemoryHit => ({
  id: 'f1',
  text: 'The cache TTL is thirty seconds.',
  type: 'world',
  context: 'Cache TTL',
  tags: ['okf', 'kind:concept', 'type:decision', 'trust:human-reviewed', 'status:stable', 'tag:cache'],
  documentId: 'okf:abc:def',
  ...over,
});

const concept = (meta: Record<string, string>, over: Partial<MemoryHit> = {}): MemoryHit =>
  hit({
    metadata: {
      concept_path: 'memory/facts/cache-ttl.md',
      concept_type: 'decision',
      status: 'stable',
      trust_tier: 'human-reviewed',
      stale_after: '2027-01-01',
      origin: 'journal',
      ...meta,
    },
    ...over,
  });

const NOW = new Date('2026-10-18T00:00:00.000Z');

describe('recallFact', () => {
  it('adds the OKF provenance of a concept to the engine’s own fields', () => {
    expect(recallFact(concept({}), NOW)).toEqual({
      id: 'f1',
      text: 'The cache TTL is thirty seconds.',
      type: 'world',
      context: 'Cache TTL',
      tags: hit().tags,
      documentId: 'okf:abc:def',
      path: 'memory/facts/cache-ttl.md',
      conceptType: 'decision',
      trustTier: 'human-reviewed',
      stale: false,
      origin: 'journal',
    });
  });

  it('judges `stale` against now, marks a deprecated concept, and leaves out a tier that is not one of the three', () => {
    expect(recallFact(concept({ stale_after: '2026-01-01' }), NOW)).toMatchObject({ stale: true });
    expect(recallFact(concept({}, { tags: [] }), NOW).stale).toBe(false);
    expect(recallFact(concept({ status: 'deprecated' }), NOW)).toMatchObject({ deprecated: true });
    const odd = recallFact(concept({ trust_tier: 'very trusted', origin: '' }), NOW);
    expect(odd).not.toHaveProperty('trustTier');
    expect(odd).not.toHaveProperty('origin');
  });

  it('leaves a fact that is not a concept of the bundle bare, whatever its metadata says', () => {
    const fact = recallFact(hit({ metadata: { trust_tier: 'human-reviewed', stale_after: '2020-01-01' } }), NOW);
    expect(fact).toEqual({
      id: 'f1',
      text: 'The cache TTL is thirty seconds.',
      type: 'world',
      context: 'Cache TTL',
      tags: hit().tags,
      documentId: 'okf:abc:def',
    });
  });
});

describe('matchesFilters', () => {
  it('keeps everything when nothing was asked for, and drops a deprecated fact by default', () => {
    expect(matchesFilters(hit(), {})).toBe(true);
    expect(matchesFilters(concept({ status: 'deprecated' }), {})).toBe(false);
    expect(matchesFilters(concept({ status: 'deprecated' }), { includeDeprecated: true })).toBe(true);
  });

  it('asks every requested tag, matching a concept’s own tag through the label the mirror filed it with', () => {
    expect(matchesFilters(concept({}), { tags: ['cache'] })).toBe(true);
    expect(matchesFilters(concept({}), { tags: ['tag:cache'] })).toBe(true);
    expect(matchesFilters(concept({}), { tags: ['okf'] })).toBe(true);
    expect(matchesFilters(concept({}), { tags: ['cache', 'nope'] })).toBe(false);
    expect(matchesFilters(concept({}), { tags: ['nope'] })).toBe(false);
  });

  it('asks for the OKF type of a concept, and leaves out a fact that is not one', () => {
    expect(matchesFilters(concept({}), { types: ['decision'] })).toBe(true);
    expect(matchesFilters(concept({}), { types: ['fact', 'decision'] })).toBe(true);
    expect(matchesFilters(concept({}), { types: ['reference'] })).toBe(false);
    // a plain retained fact has no OKF type: a `types` filter is not for it
    expect(matchesFilters(hit({ tags: ['plan'] }), { types: ['decision'] })).toBe(false);
    // …but a label it carries is still matched (the same rule as tags)
    expect(matchesFilters(hit({ tags: ['type:decision'] }), { types: ['decision'] })).toBe(true);
  });
});
