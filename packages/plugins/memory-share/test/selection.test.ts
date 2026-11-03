import { describe, expect, it } from 'vitest';
import { excludedRefs, exclusionOf, matchesFilters, selectConcepts, withdraw, withheldCounts, type SelectableConcept } from '../src/selection.ts';

// The selection engine (PLAN P8-22): pure, so every rule of SPEC §12.3 is tried here without a database.

const NOW = new Date('2026-11-02T08:00:00Z');
let n = 0;
const concept = (path: string, over: Partial<SelectableConcept> = {}): SelectableConcept => {
  n += 1;
  return {
    path: `memory/${path}`,
    type: 'Decision',
    title: path,
    description: null,
    tags: [],
    status: 'stable',
    staleAfter: null,
    trustTier: 'unverified',
    origin: '',
    shareNever: false,
    blobSha: String(n).padStart(40, '0'),
    generatedAt: null,
    ...over,
  };
};
const SELECT = { minTrust: 'unverified', skipStale: true } as const;
const run = (concepts: SelectableConcept[], select: Parameters<typeof selectConcepts>[0]['select'] = SELECT, baseline: Record<string, string> | null = null) =>
  selectConcepts({ concepts, select, baseline, now: NOW });
const reasons = (r: ReturnType<typeof run>): Record<string, string> => Object.fromEntries(r.excluded.map((e) => [e.concept.path.slice(7), e.reason]));

describe('what the filters match', () => {
  const a = concept('decisions/a.md', { type: 'Decision', tags: ['Release'] });
  const b = concept('playbooks/b.md', { type: 'Playbook', tags: ['ops'] });
  const c = concept('facts/c.md', { type: 'Fact' });

  it('takes everything when nothing is said', () => {
    expect(run([a, b, c]).included.map((i) => i.concept.path)).toEqual(['memory/decisions/a.md', 'memory/facts/c.md', 'memory/playbooks/b.md']);
  });

  it('paths: folders and files under memory/, with or without the trailing slash or a memory/ prefix', () => {
    const paths = (...p: string[]): string[] => run([a, b, c], { ...SELECT, paths: p }).included.map((i) => i.concept.path.slice(7));
    expect(paths('decisions/')).toEqual(['decisions/a.md']);
    expect(paths('decisions')).toEqual(['decisions/a.md']);
    expect(paths('memory/playbooks/')).toEqual(['playbooks/b.md']);
    expect(paths('/facts/c.md')).toEqual(['facts/c.md']);
    expect(paths('decisions/', 'facts/')).toEqual(['decisions/a.md', 'facts/c.md']);
    expect(paths('deci')).toEqual([]);
  });

  it('types and tags: any of, ignoring case', () => {
    expect(run([a, b, c], { ...SELECT, types: ['decision', 'FACT'] }).included.map((i) => i.concept.path.slice(7))).toEqual(['decisions/a.md', 'facts/c.md']);
    expect(run([a, b, c], { ...SELECT, tags: ['release', 'OPS'] }).included.map((i) => i.concept.path.slice(7))).toEqual(['decisions/a.md', 'playbooks/b.md']);
    expect(run([a, b, c], { ...SELECT, types: ['Decision'], tags: ['ops'] }).matched).toBe(0);
  });

  it('counts what the filters matched, then says what stayed out', () => {
    const r = run([a, concept('decisions/draft.md', { status: 'draft' }), b], { ...SELECT, paths: ['decisions/'] });
    expect(r.matched).toBe(2);
    expect(r.included).toHaveLength(1);
    expect(r.excluded).toHaveLength(1);
  });
});

describe('what never goes', () => {
  it('received digests and originals are not even matched when no path is named', () => {
    const r = run([concept('shared/eng/a.md'), concept('references/q3.md', { type: 'Reference' }), concept('decisions/ok.md')]);
    expect(r.matched).toBe(1);
    expect(r.excluded).toEqual([]);
  });

  it('...and when a path names them, they are left out with their reason', () => {
    const r = run([concept('shared/eng/a.md'), concept('references/q3.md', { type: 'Reference' }), concept('decisions/ok.md')], { ...SELECT, paths: ['shared/', 'references/', 'decisions/'] });
    expect(reasons(r)).toEqual({ 'shared/eng/a.md': 'received', 'references/q3.md': 'original' });
    expect(r.included.map((i) => i.concept.path)).toEqual(['memory/decisions/ok.md']);
  });

  it('a received concept anywhere (origin: share) is never passed on', () => {
    expect(reasons(run([concept('decisions/x.md', { origin: 'share' })]))).toEqual({ 'decisions/x.md': 'received' });
  });

  it('a Reference outside references/ is still an original', () => {
    expect(reasons(run([concept('decisions/x.md', { type: 'reference' })]))).toEqual({ 'decisions/x.md': 'original' });
  });

  it('a note about a person is personal', () => {
    expect(reasons(run([concept('notes/jane.md', { origin: 'person' })]))).toEqual({ 'notes/jane.md': 'personal' });
  });

  it.each([
    ['draft', { status: 'draft' as const }, 'draft'],
    ['deprecated', { status: 'deprecated' as const }, 'deprecated'],
    ['team only', { shareNever: true }, 'team_only'],
  ])('%s is left out', (_label, over, reason) => {
    expect(reasons(run([concept('x.md', over)]))).toEqual({ 'x.md': reason });
  });

  it('one reason each, the first that applies', () => {
    const everything = concept('x.md', { origin: 'share', status: 'draft', shareNever: true, trustTier: 'unverified', staleAfter: new Date('2020-01-01') });
    expect(exclusionOf(everything, { minTrust: 'human-reviewed', skipStale: true }, NOW)).toBe('received');
    expect(exclusionOf({ ...everything, origin: '' }, { minTrust: 'human-reviewed', skipStale: true }, NOW)).toBe('draft');
    expect(exclusionOf({ ...everything, origin: '', status: 'stable' }, { minTrust: 'human-reviewed', skipStale: true }, NOW)).toBe('team_only');
    expect(exclusionOf({ ...everything, origin: '', status: 'stable', shareNever: false }, { minTrust: 'human-reviewed', skipStale: true }, NOW)).toBe('trust');
    expect(exclusionOf({ ...everything, origin: '', status: 'stable', shareNever: false }, { minTrust: 'unverified', skipStale: true }, NOW)).toBe('stale');
    expect(exclusionOf({ ...everything, origin: '', status: 'stable', shareNever: false }, { minTrust: 'unverified', skipStale: false }, NOW)).toBeNull();
  });

  it('minTrust ranks unverified < machine-confirmed < human-reviewed', () => {
    const tiers = (['unverified', 'machine-confirmed', 'human-reviewed'] as const).map((t) => concept(`${t}.md`, { trustTier: t }));
    const sel = (minTrust: 'unverified' | 'machine-confirmed' | 'human-reviewed'): string[] => run(tiers, { minTrust, skipStale: true }).included.map((i) => i.concept.path.slice(7));
    expect(sel('unverified')).toEqual(['human-reviewed.md', 'machine-confirmed.md', 'unverified.md']);
    expect(sel('machine-confirmed')).toEqual(['human-reviewed.md', 'machine-confirmed.md']);
    expect(sel('human-reviewed')).toEqual(['human-reviewed.md']);
    expect(reasons(run(tiers, { minTrust: 'human-reviewed', skipStale: true }))).toEqual({ 'machine-confirmed.md': 'trust', 'unverified.md': 'trust' });
  });

  it('stale concepts stay out unless skipStale is off; a date in the future is fresh', () => {
    const old = concept('old.md', { staleAfter: new Date('2026-01-01T00:00:00Z') });
    const fresh = concept('fresh.md', { staleAfter: new Date('2027-01-01T00:00:00Z') });
    expect(reasons(run([old, fresh]))).toEqual({ 'old.md': 'stale' });
    expect(run([old, fresh], { ...SELECT, skipStale: false }).included).toHaveLength(2);
  });
});

describe('only what changed goes', () => {
  const a = concept('a.md');
  const b = concept('b.md');
  const c = concept('c.md');

  it('with no earlier delivery, everything is new', () => {
    const r = run([a, b, c]);
    expect(r.included.map((i) => i.change)).toEqual(['added', 'added', 'added']);
    expect(r.unchanged).toEqual([]);
  });

  it('by content hash: the same hash does not go again, a new hash is "changed", a new path is "added"', () => {
    const changedB = { ...b, blobSha: 'f'.repeat(40) };
    const r = run([a, changedB, c], SELECT, { [a.path]: a.blobSha, [b.path]: b.blobSha });
    expect(r.unchanged.map((x) => x.path)).toEqual([a.path]);
    expect(r.included.map((i) => [i.concept.path.slice(7), i.change])).toEqual([['b.md', 'changed'], ['c.md', 'added']]);
    expect(r.manifest).toEqual({ [a.path]: a.blobSha, [b.path]: 'f'.repeat(40), [c.path]: c.blobSha });
  });

  it('a concept the sender has since retired is named, not copied again', () => {
    const gone = { ...b, status: 'deprecated' as const };
    const teamOnly = { ...c, shareNever: true };
    const r = run([a, gone, teamOnly], SELECT, { [a.path]: a.blobSha, [b.path]: b.blobSha, [c.path]: c.blobSha });
    expect(r.retired.map((x) => x.path)).toEqual([b.path, c.path]);
    expect(r.included).toEqual([]);
    expect(Object.keys(r.manifest)).toEqual([a.path]);
  });

  it('retires nothing when nothing was ever sent', () => {
    expect(run([{ ...b, status: 'deprecated' }]).retired).toEqual([]);
  });

  it('is the same on every run: the order of the input does not matter', () => {
    const forward = run([a, b, c]);
    const backward = run([c, b, a]);
    expect(backward.included.map((i) => i.concept.path)).toEqual(forward.included.map((i) => i.concept.path));
  });

  it('cuts a selection at the most a digest carries; the rest say "too_large" and are not in the manifest', () => {
    const many = Array.from({ length: 5 }, (_, i) => concept(`m/${i}.md`));
    const r = selectConcepts({ concepts: many, select: SELECT, baseline: null, now: NOW, max: 3 });
    expect(r.included).toHaveLength(3);
    expect(r.excluded.map((e) => e.reason)).toEqual(['too_large', 'too_large']);
    expect(Object.keys(r.manifest)).toHaveLength(3);
  });
});

describe('withdrawing what the later steps could not send', () => {
  it('moves it to the left-out list with its reason and out of the manifest', () => {
    const a = concept('a.md');
    const b = concept('b.md');
    const r = withdraw(run([a, b]), new Map([[b.path, 'dlp' as const]]));
    expect(r.included.map((i) => i.concept.path)).toEqual([a.path]);
    expect(reasons(r)).toEqual({ 'b.md': 'dlp' });
    expect(Object.keys(r.manifest)).toEqual([a.path]);
  });

  it('a concept the data rules stopped is named by its path, never its title; the counts are by reason', () => {
    const b = concept('b.md', { title: 'Password is hunter2' });
    const r = withdraw(run([b]), new Map([[b.path, 'dlp' as const]]));
    expect(excludedRefs(r)).toEqual([{ path: b.path, title: 'b.md', reason: 'dlp' }]);
    expect(withheldCounts(r)).toEqual({ dlp: 1 });
  });
});

describe('matchesFilters on its own', () => {
  it('knows a folder by its trailing slash and does not match a longer name', () => {
    expect(matchesFilters(concept('decisions-old/a.md'), { paths: ['decisions/'] })).toBe(false);
    expect(matchesFilters(concept('decisions/sub/a.md'), { paths: ['decisions/'] })).toBe(true);
  });
});
