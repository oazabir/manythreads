import type { MemoryLogLine } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { DEFER_GIVE_UP_MS } from '../src/constants.ts';
import { decide, type Provenance, type Resolution } from '../src/decide.ts';
import { conceptDigest, documentIdFor, type ConceptItem } from '../src/render.ts';

// The whole of "what should happen to the bank for this concept" as a table: a pure function of (what the file is now, what the log says is in
// the bank, how long the decision has waited).

const KEY = Buffer.alloc(32, 3);
const PATH = 'memory/facts/deploy-freeze.md';
const at: Provenance = { teamId: 't', workspaceId: 'w', actorId: null, link: '/t/e/files?open=x' };
const item = (text: string): ConceptItem => ({
  content: text,
  context: 'Concept: x',
  timestamp: '2026-10-12T09:00:00.000Z',
  tags: ['okf'],
  metadata: {},
  hashInput: JSON.stringify([text]),
  trust: 'unverified',
});
const hashOf = (text: string): string => conceptDigest(item(text), KEY);
const line = (over: Partial<MemoryLogLine>): MemoryLogLine => ({
  id: 'l1',
  team_id: 't',
  workspace_id: 'w',
  bank: 'team:w:t',
  document_id: null,
  content_hash: null,
  outcome: 'retained',
  reason: '',
  channel_id: null,
  created_at: new Date(),
  ...over,
});
const heldText = (text: string): MemoryLogLine => line({ outcome: 'retained', document_id: documentIdFor(PATH, hashOf(text)), content_hash: hashOf(text) });
const run = (res: Resolution, last: MemoryLogLine | null, deferredForMs = 0) => decide({ path: PATH, res, last, deferredForMs, key: KEY });
const retain = (text: string): Resolution => ({ action: 'retain', at, item: item(text) });

describe('a valid concept', () => {
  it('is retained when the bank holds nothing for it, under path + keyed digest', () => {
    const d = run(retain('v1'), null);
    expect(d.retain).toMatchObject({ documentId: documentIdFor(PATH, hashOf('v1')), hash: hashOf('v1') });
    expect(d.forget).toBeNull();
    expect(d.withhold).toBeNull();
  });

  it('is nothing when the bank already holds exactly this text', () => {
    expect(run(retain('v1'), heldText('v1'))).toEqual({ forget: null, retain: null, withhold: null, defer: null });
  });

  it('an edit forgets the old document and retains the new one', () => {
    const d = run(retain('v2'), heldText('v1'));
    expect(d.forget).toEqual({ documentId: documentIdFor(PATH, hashOf('v1')), reason: 'replaced' });
    expect(d.retain?.documentId).toBe(documentIdFor(PATH, hashOf('v2')));
  });

  it('is retained again after it was forgotten (a deprecated concept made stable again)', () => {
    const last = line({ outcome: 'forgotten', document_id: documentIdFor(PATH, hashOf('v1')), content_hash: hashOf('v1'), reason: 'deprecated' });
    const d = run(retain('v1'), last);
    expect(d.retain?.documentId).toBe(documentIdFor(PATH, hashOf('v1')));
    expect(d.forget).toBeNull();
  });
});

describe('forgetting', () => {
  it('takes out the document the newest line says is held', () => {
    expect(run({ action: 'forget', reason: 'deleted' }, heldText('v1')).forget).toEqual({ documentId: documentIdFor(PATH, hashOf('v1')), reason: 'deleted' });
  });

  it('is nothing when nothing was ever held, or when the last word was a forget already', () => {
    expect(run({ action: 'forget', reason: 'deleted' }, null).forget).toBeNull();
    expect(run({ action: 'forget', reason: 'deleted' }, line({ outcome: 'forgotten', document_id: 'd' })).forget).toBeNull();
  });
});

describe('withholding', () => {
  it('writes one line per reason and takes out what was held', () => {
    const d = run({ action: 'withhold', at, reason: 'okf_invalid: the frontmatter has no `type`' }, heldText('v1'));
    expect(d.withhold).toEqual({ at, reason: 'okf_invalid: the frontmatter has no `type`' });
    expect(d.forget?.documentId).toBe(documentIdFor(PATH, hashOf('v1')));
    const again = run({ action: 'withhold', at, reason: 'okf_invalid: the frontmatter has no `type`' }, line({ outcome: 'withheld', reason: 'okf_invalid: the frontmatter has no `type`' }));
    expect(again.withhold).toBeNull();
    const other = run({ action: 'withhold', at, reason: 'authoring run: person_source' }, line({ outcome: 'withheld', reason: 'okf_invalid: x' }));
    expect(other.withhold?.reason).toBe('authoring run: person_source');
  });
});

describe('deferring', () => {
  it('waits for a run that has not closed, and after a day withholds as run_open', () => {
    expect(run({ action: 'defer', at, reason: 'run_open' }, null, 1_000)).toMatchObject({ defer: { reason: 'run_open' }, retain: null, withhold: null });
    const given = run({ action: 'defer', at, reason: 'run_open' }, heldText('v1'), DEFER_GIVE_UP_MS);
    expect(given.defer).toBeNull();
    expect(given.withhold?.reason).toBe('run_open');
    expect(given.forget).not.toBeNull();
  });
});

describe('skipping', () => {
  it('does nothing', () => {
    expect(run({ action: 'skip', reason: 'not_a_concept' }, heldText('v1'))).toEqual({ forget: null, retain: null, withhold: null, defer: null });
  });
});
