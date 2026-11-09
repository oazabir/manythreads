import { setTraceBridge, type SpanAttributes, type TraceBridge } from '@manythreads/sdk';
import type { ActorId, RunId, WorkspaceId } from '@manythreads/shared';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { systemActor, withActor, type Actor } from '../src/db/with-actor.ts';

// The database entry opens one span per transaction when a request or job is being traced, and nothing at all otherwise. No database: the pool is a stand-in that records statements.

const WORKSPACE = '33333333-3333-3333-3333-333333333333' as WorkspaceId;
const person: Actor = { kind: 'person', id: '44444444-4444-4444-4444-444444444444' as ActorId, workspaceId: WORKSPACE, runId: '55555555-5555-5555-5555-555555555555' as RunId };

function fakePool(): { pool: pg.Pool; statements: string[] } {
  const statements: string[] = [];
  const client = {
    query: async (text: string) => (statements.push(text.trim().split(/\s+/)[0] ?? ''), { rows: [] }),
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, statements };
}

interface Recorded {
  name: string;
  attributes: SpanAttributes;
  state: 'open' | 'done' | 'failed';
}

function recordingBridge(active = true): { bridge: TraceBridge; spans: Recorded[] } {
  const spans: Recorded[] = [];
  const bridge: TraceBridge = {
    async span(name, attributes, fn) {
      // like the real bridge: nothing is started outside a trace
      if (!active) return fn();
      const rec: Recorded = { name, attributes, state: 'open' };
      spans.push(rec);
      try {
        const v = await fn();
        rec.state = 'done';
        return v;
      } catch (err) {
        rec.state = 'failed';
        throw err;
      }
    },
    root: (_n, _a, fn) => fn(),
    request: () => undefined,
    headers: () => ({}),
    traceId: () => undefined,
  };
  return { bridge, spans };
}

afterEach(() => setTraceBridge(null));

describe('withActor and tracing', () => {
  it('with no bridge it is the plain transaction: BEGIN, settings, COMMIT, and the result', async () => {
    const { pool, statements } = fakePool();
    const out = await withActor(person, async (tx) => (await tx.query('SELECT 1'), 'done'), { pool });
    expect(out).toBe('done');
    expect(statements).toEqual(['BEGIN', 'SELECT', 'SELECT', 'COMMIT']);
  });

  it('opens one db.transaction span around the whole transaction, with kinds and ids only', async () => {
    const { bridge, spans } = recordingBridge();
    setTraceBridge(bridge);
    const { pool, statements } = fakePool();
    await withActor(person, async (tx) => void (await tx.query('SELECT * FROM app.messages WHERE body = $1', ['a private sentence'])), { pool, readOnly: true });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: 'db.transaction',
      state: 'done',
      attributes: { 'mt.db.actor_kind': 'person', 'mt.workspace_id': WORKSPACE, 'mt.run_id': person.runId, 'mt.db.read_only': true },
    });
    expect(statements[0]).toBe('BEGIN');
    // neither the statement text nor its values may ride on the span
    expect(JSON.stringify(spans)).not.toMatch(/private sentence|SELECT|messages/);
  });

  it('the system actor carries no workspace when it has none', async () => {
    const { bridge, spans } = recordingBridge();
    setTraceBridge(bridge);
    await withActor(systemActor(), async () => undefined, { pool: fakePool().pool });
    expect(spans[0]?.attributes['mt.workspace_id']).toBeUndefined();
    expect(spans[0]?.attributes['mt.db.actor_kind']).toBe('system');
  });

  it('a failing transaction ends its span as failed, rolls back and rethrows the same error', async () => {
    const { bridge, spans } = recordingBridge();
    setTraceBridge(bridge);
    const { pool, statements } = fakePool();
    const boom = new Error('constraint violated');
    await expect(withActor(person, async () => Promise.reject(boom), { pool })).rejects.toBe(boom);
    expect(spans[0]?.state).toBe('failed');
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('outside a trace (a background poll) no span is started', async () => {
    const { bridge, spans } = recordingBridge(false);
    setTraceBridge(bridge);
    await withActor(person, async () => undefined, { pool: fakePool().pool });
    expect(spans).toEqual([]);
  });
});
