import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { registerCapabilities } from '../src/capabilities.ts';

// `tasks.handoff` with a `privateNote` seals the text in the secret store and tells nobody else; `tasks.private_note` gives it back to the bot
// that now owns the card. The database is a stub answering by SQL; what is under test is where the text goes, and where it must not.

const SECRET_TEXT = 'hunter2-very-secret';
const ids = {
  task: '01a16e30-0000-7000-8000-000000000001', ws: '01a16e30-0000-7000-8000-000000000002', team: '01a16e30-0000-7000-8000-000000000003',
  from: '01a16e30-0000-7000-8000-000000000004', to: '01a16e30-0000-7000-8000-000000000005', handoff: '01a16e30-0000-7000-8000-000000000006',
  channel: '01a16e30-0000-7000-8000-000000000007', message: '01a16e30-0000-7000-8000-000000000008', secret: '01a16e30-0000-7000-8000-000000000009',
};
const taskRow = (owner: string) => ({
  id: ids.task, workspace_id: ids.ws, team_id: ids.team, goal_id: null, title: 'Fix the rota', description: '', state: 'in_progress', kind: 'other', priority: 'normal',
  owner_id: owner, branch: 'fix/rota', base_sha: null, tested_sha: null, environment_id: null, thread_root_id: null, blocker_reason: '', rework_count: 0,
  handoff_count: 0, created_by: ids.from, created_at: new Date(), updated_at: new Date(), completed_at: null,
});

function harness(actor: { id: string; kind: 'bot' | 'person' }, secretIdForCaller: string | null = ids.secret) {
  const sql: { text: string; params: unknown[] }[] = [];
  const emitted: unknown[] = [];
  const posted: { body: string }[] = [];
  const stored: string[] = [];
  const handlers = new Map<string, (input: Record<string, unknown>, tx: PluginTx) => Promise<Record<string, unknown>>>();
  const query = (text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    sql.push({ text, params });
    const rows = (r: unknown[]) => Promise.resolve({ rows: r });
    if (text.includes('FROM app.tasks t')) return rows([taskRow(ids.to)]);
    if (text.includes('app.tasks_handoff(')) return rows([{ o_outcome: 'moved', o_handoff_id: ids.handoff, o_reason: '' }]);
    if (text.includes('app.tasks_set_private_note')) return rows([{ ok: true }]);
    if (text.includes('app.tasks_private_note_secret')) return rows([{ id: secretIdForCaller }]);
    if (text.includes('FROM app.handoffs WHERE id')) {
      return rows([{ id: ids.handoff, task_id: ids.task, team_id: ids.team, from_actor_id: ids.from, to_actor_id: ids.to, mode: 'bot', note: 'url and emails', approval_id: null, applied_at: new Date(), created_at: new Date() }]);
    }
    if (text.includes('FROM app.capability_grants')) return rows([{ constraints: { mayTag: ['browser-tester'] } }]);
    if (text.includes('FROM app.actors WHERE id')) return rows([{ kind: 'bot' }]);
    if (text.includes('app.tasks_actor_of')) return rows([{ kind: 'bot', ref_id: '01a16e30-0000-7000-8000-0000000000aa', name: 'Browser tester' }]);
    if (text.includes('FROM app.bots WHERE id')) return rows([{ slug: 'browser-tester' }]);
    if (text.includes('FROM app.channels c')) return rows([{ id: ids.channel }]);
    return rows([]);
  };
  const tx = { actor: { ...actor, workspaceId: ids.ws }, query } as unknown as PluginTx;
  const ctx = {
    capabilities: { register: (n: string, fn: never) => handlers.set(n, fn), authorize: () => Promise.resolve({ allowed: true, needsApproval: false, reason: '' }) },
    audit: { emit: (_tx: PluginTx, event: unknown) => { emitted.push(event); return Promise.resolve(); } },
    providers: { get: (n: string) => (n === 'messages' ? { post: (_t: PluginTx, input: { body: string }) => { posted.push(input); return Promise.resolve({ id: ids.message }); } } : undefined) },
    db: { system: (fn: (t: PluginTx) => Promise<unknown>) => fn({ query } as unknown as PluginTx) },
    secrets: { put: (_t: PluginTx, text: string) => { stored.push(text); return Promise.resolve(ids.secret); }, get: () => Promise.resolve(SECRET_TEXT) },
  } as unknown as PluginContext;
  registerCapabilities(ctx);
  return { sql, emitted, posted, stored, run: (name: string, input: Record<string, unknown>) => handlers.get(name)!(input, tx) };
}

describe('tasks.handoff with a privateNote', () => {
  it('seals the text, links it to the handover, and keeps it out of the thread message and the events', async () => {
    const h = harness({ id: ids.from, kind: 'bot' });
    const out = await h.run('tasks.handoff', { taskId: ids.task, toActorId: ids.to, note: 'url and emails', privateNote: SECRET_TEXT });
    expect(out).toMatchObject({ ok: true, privateNoteSealed: true });
    expect(h.stored).toEqual([SECRET_TEXT]);
    expect(h.sql.find((s) => s.text.includes('tasks_ticket_private_note'))?.params).toEqual([ids.secret, ids.from]);
    expect(h.sql.find((s) => s.text.includes('tasks_set_private_note'))?.params).toEqual([ids.handoff, ids.secret]);
    expect(h.posted[0]?.body).toContain('a private note was passed to @browser-tester');
    expect(JSON.stringify(h.posted)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(h.emitted)).not.toContain(SECRET_TEXT);
    // No query parameter other than the secret store's own put carries the text.
    expect(JSON.stringify(h.sql)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(out)).not.toContain(SECRET_TEXT);
  });

  it('refuses an empty or oversized private note before anything moves', async () => {
    for (const bad of ['', 'x'.repeat(4001), 7]) {
      const h = harness({ id: ids.from, kind: 'bot' });
      expect(await h.run('tasks.handoff', { taskId: ids.task, toActorId: ids.to, privateNote: bad })).toMatchObject({ ok: false, code: 'invalid_input' });
      expect(h.sql.some((s) => s.text.includes('app.tasks_handoff('))).toBe(false);
    }
  });

  it('a handover without a private note stores nothing', async () => {
    const h = harness({ id: ids.from, kind: 'bot' });
    expect(await h.run('tasks.handoff', { taskId: ids.task, toActorId: ids.to, note: 'plain' })).toMatchObject({ ok: true });
    expect(h.stored).toEqual([]);
    expect(h.posted[0]?.body).not.toContain('private note');
  });
});

describe('tasks.private_note', () => {
  it('gives the note to the bot the database names as its recipient', async () => {
    const h = harness({ id: ids.to, kind: 'bot' });
    expect(await h.run('tasks.private_note', { taskId: ids.task })).toMatchObject({ ok: true, privateNote: SECRET_TEXT });
  });

  it('is refused when the database finds no note for the caller (another bot, the card moved on)', async () => {
    const h = harness({ id: ids.from, kind: 'bot' }, null);
    expect(await h.run('tasks.private_note', { taskId: ids.task })).toMatchObject({ ok: false, code: 'no_private_note' });
  });

  it('is refused for a person without asking the database', async () => {
    const h = harness({ id: ids.from, kind: 'person' });
    expect(await h.run('tasks.private_note', { taskId: ids.task })).toMatchObject({ ok: false, code: 'no_private_note' });
    expect(h.sql.some((s) => s.text.includes('tasks_private_note_secret'))).toBe(false);
  });
});
