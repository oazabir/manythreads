import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { registerCapabilities } from '../src/capabilities.ts';

// A bot must be able to tell its own cards from another's: `tasks.read` names every owner and creator next to the id and marks the
// caller's own, and `tasks.claim` by the card's current owner succeeds without a second claim. The database is a stub answering by SQL.

const ME = '01a16e30-0000-7000-8000-0000000000a1';
const CODER = '01a16e30-0000-7000-8000-0000000000a2';
const NADIA = '01a16e30-0000-7000-8000-0000000000a3';
const TASK = '01a16e30-0000-7000-8000-0000000000b1';
const TASK2 = '01a16e30-0000-7000-8000-0000000000b2';

function harness(claimAnswer?: { o_outcome: string; o_owner_id: string | null }) {
  const sql: string[] = [];
  const handlers = new Map<string, (input: Record<string, unknown>, tx: PluginTx) => Promise<Record<string, unknown>>>();
  const query = (text: string): Promise<{ rows: unknown[] }> => {
    sql.push(text);
    const rows = (r: unknown[]) => Promise.resolve({ rows: r });
    if (text.includes('FROM app.tasks t')) {
      return rows([
        { id: TASK, title: 'Mine', owner_id: ME, created_by: NADIA },
        { id: TASK2, title: 'Theirs', owner_id: CODER, created_by: ME },
      ]);
    }
    if (text.includes('app.tasks_actor_labels')) {
      return rows([
        { o_actor_id: ME, o_kind: 'bot', o_name: 'Reviewer', o_slug: 'reviewer' },
        { o_actor_id: CODER, o_kind: 'bot', o_name: 'Coder', o_slug: 'coder' },
        { o_actor_id: NADIA, o_kind: 'person', o_name: 'Nadia Rahman', o_slug: null },
      ]);
    }
    if (text.includes('app.tasks_claim(')) return rows(claimAnswer ? [{ ...claimAnswer, o_expires_at: null }] : []);
    if (text.includes('FROM app.task_claims')) return rows([{ expires_at: new Date('2030-01-01T00:00:00Z') }]);
    return rows([]);
  };
  const tx = { actor: { id: ME, kind: 'bot', workspaceId: 'w' }, query } as unknown as PluginTx;
  registerCapabilities({ capabilities: { register: (n: string, fn: never) => handlers.set(n, fn) } } as unknown as PluginContext);
  return { sql, run: (name: string, input: Record<string, unknown>) => handlers.get(name)!(input, tx) };
}

describe('tasks.read names who holds a card', () => {
  it('writes the bot slug or the person name next to each id and marks the caller as (you)', async () => {
    const out = await harness().run('tasks.read', {});
    expect(out['you']).toBe('reviewer (you)');
    const [mine, theirs] = out['tasks'] as { owner_id: string; owner: string; creator: string }[];
    expect(mine).toMatchObject({ owner_id: ME, owner: 'reviewer (you)', creator: 'Nadia Rahman' });
    expect(theirs).toMatchObject({ owner_id: CODER, owner: 'coder', creator: 'reviewer (you)' });
  });
});

describe('tasks.claim by the current owner', () => {
  it('succeeds without a new claim, and says the card was already yours', async () => {
    const h = harness({ o_outcome: 'already_owned', o_owner_id: ME });
    expect(await h.run('tasks.claim', { taskId: TASK })).toMatchObject({ ok: true, taskId: TASK, alreadyYours: true, expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(h.sql.some((s) => /INSERT|UPDATE/i.test(s))).toBe(false);
  });

  it('is still refused when someone else holds the card', async () => {
    const h = harness({ o_outcome: 'already_owned', o_owner_id: CODER });
    expect(await h.run('tasks.claim', { taskId: TASK })).toMatchObject({ ok: false, code: 'already_owned' });
  });
});
