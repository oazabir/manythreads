import { expectLinear } from '@manythreads/test-utils/linear';
import { describe, expect, it } from 'vitest';
import { parseConcept } from '@manythreads/shared';
import { MAX_DOC_CHARS } from '../src/constants.ts';
import { clip, conceptDigest, conceptSourceId, documentIdFor, renderConcept, tidy, type ConceptInput } from '../src/render.ts';

// Pure: what a concept becomes as a document, the digest that recognises it again and the id the engine files it under.

const KEY = Buffer.alloc(32, 7);
const fm = (text: string) => {
  const parsed = parseConcept(`---\n${text}\n---\n\nbody`);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.frontmatter;
};
const input = (frontmatter: string, over: Partial<ConceptInput> = {}): ConceptInput => ({
  path: 'memory/decisions/use-postgres.md',
  teamSlug: 'engineering',
  frontmatter: fm(frontmatter),
  body: '# Use Postgres\n\nWe chose it for RLS.\n',
  authorId: '0190a000-0000-7000-8000-000000000001',
  authorName: 'Nadia',
  committedAt: '2026-10-12T09:14:30.000Z',
  ...over,
});

describe('renderConcept', () => {
  it('says what the concept is, then its title, description and body', () => {
    const item = renderConcept(input('type: Decision\ntitle: Use Postgres\ndescription: Why the database is Postgres'));
    expect(item.content).toBe(
      [
        'Memory concept memory/decisions/use-postgres.md (type Decision, status stable, trust unverified, last written by Nadia on 2026-10-12 09:14):',
        '# Use Postgres',
        'Why the database is Postgres',
        '# Use Postgres\n\nWe chose it for RLS.',
      ].join('\n\n'),
    );
    expect(item.context).toBe('Concept: Use Postgres');
    expect(item.timestamp).toBe('2026-10-12T09:14:30.000Z');
  });

  it('carries type, trust tier, status, origin and the concept’s own tags as tags, and its provenance as metadata', () => {
    const item = renderConcept(
      input('type: Playbook\ntags: [Release, On-Call]\nstatus: draft\norigin: drop\nverified:\n  - by: human:u1\n    at: 2026-10-01\nstale_after: 2027-01-01'),
    );
    expect(item.tags).toEqual(['okf', 'kind:concept', 'type:playbook', 'trust:human-reviewed', 'status:draft', 'origin:drop', 'tag:release', 'tag:on-call']);
    expect(item.metadata).toMatchObject({
      feed_kind: 'concept',
      feed_id: 'memory/decisions/use-postgres.md',
      concept_path: 'memory/decisions/use-postgres.md',
      concept_type: 'Playbook',
      status: 'draft',
      trust_tier: 'human-reviewed',
      origin: 'drop',
      stale_after: '2027-01-01',
      actor: '0190a000-0000-7000-8000-000000000001',
      actor_name: 'Nadia',
      link: '/t/engineering/files?open=memory%2Fdecisions%2Fuse-postgres.md',
    });
  });

  it('names the file when it has no title, and a concept nobody signed by its time only', () => {
    const item = renderConcept(input('type: Fact', { path: 'memory/facts/deploy-freeze.md', authorId: null, authorName: null }));
    expect(item.content.split('\n\n').slice(0, 2)).toEqual(['Memory concept memory/facts/deploy-freeze.md (type Fact, status stable, trust unverified, last written on 2026-10-12 09:14):', '# deploy-freeze']);
    expect(item.metadata['actor']).toBeUndefined();
  });

  it('a machine verifier is machine-confirmed, not human-reviewed', () => {
    expect(renderConcept(input('type: Fact\nverified:\n  by: archivist/smart')).trust).toBe('machine-confirmed');
  });

  it('cuts a concept the engine could not take, and says so', () => {
    const item = renderConcept(input('type: Fact', { body: `${'word '.repeat(10_000)}` }));
    expect(item.content.length).toBeLessThanOrEqual(MAX_DOC_CHARS);
    expect(item.content.endsWith('[the concept continues in the file]')).toBe(true);
  });

  it('keeps tag values plain, short and few', () => {
    const item = renderConcept(input(`type: "Weird Type / With 𝒰nicode"\ntags: [${Array.from({ length: 30 }, (_, i) => `t${i}`).join(', ')}]`));
    expect(item.tags.length).toBeLessThanOrEqual(20);
    for (const t of item.tags) expect(t).toMatch(/^[a-z0-9:._-]{1,64}$/);
    expect(item.tags).toContain('type:weird-type-with-unicode');
  });
});

describe('the digest and the document id', () => {
  it('is the same for the same concept and different when anything the bank shows changes', () => {
    const base = renderConcept(input('type: Fact'));
    expect(conceptDigest(renderConcept(input('type: Fact')), KEY)).toBe(conceptDigest(base, KEY));
    for (const changed of [
      renderConcept(input('type: Fact', { body: 'other body' })),
      renderConcept(input('type: Decision')),
      renderConcept(input('type: Fact\nstatus: draft')),
      renderConcept(input('type: Fact\norigin: share')),
      renderConcept(input('type: Fact\nverified:\n  by: human:u1')),
      renderConcept(input('type: Fact\ntags: [new]')),
    ]) {
      expect(conceptDigest(changed, KEY)).not.toBe(conceptDigest(base, KEY));
    }
  });

  it('is keyed: another workspace’s key names the same concept differently, and the id carries only a prefix of it', () => {
    const item = renderConcept(input('type: Fact'));
    const a = conceptDigest(item, KEY);
    const b = conceptDigest(item, Buffer.alloc(32, 9));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    const id = documentIdFor('memory/facts/x.md', a);
    expect(id).toMatch(/^okf:[0-9a-f]{24}:[0-9a-f]{16}$/);
    expect(id.endsWith(a.slice(0, 16))).toBe(true);
    expect(id.startsWith('run:') || id.startsWith('platform:') || id.startsWith('feed:')).toBe(false);
  });

  it('names one concept under one prefix whatever its text, and two paths differently', () => {
    expect(documentIdFor('memory/a.md', 'a'.repeat(64)).split(':')[1]).toBe(documentIdFor('memory/a.md', 'b'.repeat(64)).split(':')[1]);
    expect(documentIdFor('memory/a.md', 'a'.repeat(64))).not.toBe(documentIdFor('memory/b.md', 'a'.repeat(64)));
  });

  it('a source id is the team and the path', () => {
    expect(conceptSourceId('t1', 'memory/facts/x.md')).toBe('t1/memory/facts/x.md');
  });
});

describe('text helpers', () => {
  it('clip never ends inside a surrogate pair', () => {
    const text = `${'a'.repeat(9)}😀tail`;
    expect(clip(text, 11)).toBe(`${'a'.repeat(9)}…`);
    expect(clip('short', 100)).toBe('short');
  });

  it('tidy collapses blank runs and trailing spaces in linear time', () => {
    expect(tidy('a  \n\n\n\nb\r\n\r\n\r\nc  ')).toBe('a\n\nb\n\nc');
    expectLinear((n) => '\n'.repeat(n), (input) => tidy(input), { n: 250_000, label: 'tidy' });
  });
});
