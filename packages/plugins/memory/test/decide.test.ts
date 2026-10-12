import { describe, expect, it } from 'vitest';
import { DEFER_GIVE_UP_MS } from '../src/constants.ts';
import { decide } from '../src/decide.ts';
import { contentHash, documentIdFor } from '../src/render.ts';
import type { LastLine } from '../src/rows.ts';
import type { Provenance, Resolution } from '../src/sources.ts';

// The reconcile table: what the bank should do for a source, from (what the source is now) x (what the log says it holds).

const ID = '01a12f92-3e2a-78fd-88fd-5762c95a772b';
const KEY = Buffer.alloc(32, 3);
const at: Provenance = { teamId: 't', workspaceId: 'w', channelId: 'c', runId: null, actorId: 'a', scopes: [], link: '/l' };
const item = (content: string) => ({ content, context: 'ctx', timestamp: '2026-10-12T09:00:00.000Z', tags: ['feed'], metadata: {} });
const retain = (content: string): Resolution => ({ action: 'retain', at, item: item(content) });
const line = (over: Partial<LastLine>): LastLine => ({
  id: 'l1',
  team_id: 't',
  workspace_id: 'w',
  bank: 'team:ws:t',
  document_id: null,
  content_hash: null,
  outcome: 'retained',
  reason: '',
  channel_id: 'c',
  created_at: new Date(),
  ...over,
});
const held = (content: string): LastLine => {
  const hash = contentHash(content, KEY);
  return line({ document_id: documentIdFor('message', ID, hash), content_hash: hash });
};
const run = (res: Resolution, last: LastLine | null, deferredForMs = 0) => decide({ kind: 'message', sourceId: ID, res, last, deferredForMs, key: KEY });

describe('retain', () => {
  it('a source the bank holds nothing for is retained, under a document id of its kind, id and text', () => {
    const d = run(retain('hello'), null);
    expect(d.retain).toMatchObject({ documentId: documentIdFor('message', ID, contentHash('hello', KEY)), hash: contentHash('hello', KEY) });
    expect(d.forget).toBeNull();
    expect(d.withhold).toBeNull();
  });

  it('the same text delivered again is nothing at all (idempotent)', () => {
    expect(run(retain('hello'), held('hello'))).toEqual({ forget: null, retain: null, withhold: null, defer: null });
  });

  it('an edit retains the new version and forgets the old one by the id the log remembers', () => {
    const d = run(retain('hello, edited'), held('hello'));
    expect(d.retain?.documentId).toBe(documentIdFor('message', ID, contentHash('hello, edited', KEY)));
    expect(d.forget).toEqual({ documentId: documentIdFor('message', ID, contentHash('hello', KEY)), reason: 'replaced' });
  });

  it('after a forget or a withhold the next retain does not try to forget anything', () => {
    for (const outcome of ['forgotten', 'withheld', 'not_configured', 'failed']) {
      const d = run(retain('hello'), line({ outcome, document_id: 'feed:message:x:y', content_hash: contentHash('hello', KEY) }));
      expect(d.retain).not.toBeNull();
      expect(d.forget, outcome).toBeNull();
    }
  });
});

describe('forget', () => {
  it('forgets what the bank holds, with the reason', () => {
    expect(run({ action: 'forget', reason: 'deleted' }, held('hello')).forget).toEqual({ documentId: documentIdFor('message', ID, contentHash('hello', KEY)), reason: 'deleted' });
    expect(run({ action: 'forget', reason: 'not_team_visible' }, held('hello')).forget?.reason).toBe('not_team_visible');
  });

  it('is nothing when the bank held nothing (a DM that was never retained, a second delete)', () => {
    const none = { forget: null, retain: null, withhold: null, defer: null };
    expect(run({ action: 'forget', reason: 'deleted' }, null)).toEqual(none);
    expect(run({ action: 'forget', reason: 'deleted' }, line({ outcome: 'forgotten' }))).toEqual(none);
  });
});

describe('withhold (the narrowest-source rule)', () => {
  const withhold: Resolution = { action: 'withhold', at, reason: 'person_source' };

  it('logs the reason once and retains nothing', () => {
    expect(run(withhold, null)).toEqual({ forget: null, retain: null, withhold: { at, reason: 'person_source' }, defer: null });
    expect(run(withhold, line({ outcome: 'withheld', reason: 'person_source' })).withhold).toBeNull();
    expect(run(withhold, line({ outcome: 'withheld', reason: 'private_source' })).withhold).toMatchObject({ reason: 'person_source' });
  });

  it('takes out what the bank already holds for the source', () => {
    const d = run(withhold, held('hello'));
    expect(d.forget).toMatchObject({ reason: 'person_source' });
    expect(d.withhold).toMatchObject({ reason: 'person_source' });
    expect(d.retain).toBeNull();
  });
});

describe('defer and skip', () => {
  const defer: Resolution = { action: 'defer', at, reason: 'run_open' };

  it('waits for a run that has not closed, and gives up after a day by withholding it', () => {
    expect(run(defer, null, 1000)).toEqual({ forget: null, retain: null, withhold: null, defer: { reason: 'run_open' } });
    const d = run(defer, null, DEFER_GIVE_UP_MS);
    expect(d.defer).toBeNull();
    expect(d.withhold).toEqual({ at, reason: 'run_open' });
  });

  it('a skip does nothing', () => {
    expect(run({ action: 'skip', reason: 'pending' }, held('x'))).toEqual({ forget: null, retain: null, withhold: null, defer: null });
  });
});
