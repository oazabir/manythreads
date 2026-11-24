import { GetAttentionResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// The attention bar's route (owner request 2026-11-24): a runner whose sign-in expired or is missing, and a model key the provider refused, for the admins only.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 120_000 });
let w: RepoWorld;

beforeAll(async () => {
  w = await createRepoWorld();
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('GET /api/admin/attention', () => {
  it('names an expired runner sign-in and a refused model key to an admin, until the key is changed; a member gets nothing', async () => {
    const ws = await w.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.workspaces ORDER BY id LIMIT 1')).rows[0]!.id);
    const provider = await w.system(async (tx) => {
      await tx.query(`INSERT INTO app.bot_runners (workspace_id, name, label, kind, status) VALUES ($1, 'claude-x', 'Claude X', 'claude_cli', 'needs_sign_in'), ($1, 'quiet', 'Quiet', 'claude_cli', 'ready')`, [ws]);
      const p = (await tx.query<{ id: string }>(`INSERT INTO app.llm_providers (workspace_id, name, kind) VALUES ($1, 'Acme models', 'openai') RETURNING id`, [ws])).rows[0]!.id;
      await tx.query(`INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model, updated_at) VALUES ($1, 'smart', $2, 'm', now() - interval '1 hour')`, [ws, p]);
      await tx.query(`UPDATE app.llm_providers SET updated_at = now() - interval '1 hour' WHERE id = $1`, [p]);
      await tx.query(
        `INSERT INTO app.llm_alias_tests (workspace_id, alias, outcome, cause, message, model, latency_ms, tested_at, tested_by) VALUES ($1, 'smart', 'failed', 'auth', 'refused', NULL, 5, now(), NULL)`,
        [ws],
      );
      return p;
    });
    const res = await w.call(omar, 'GET', '/api/admin/attention');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { problems } = GetAttentionResponse.parse(res.body);
    expect(problems.map((p) => p.kind)).toEqual(['runner_sign_in', 'model_key']);
    expect(problems[0]!.text).toContain('Claude Code sign-in of runner “Claude X” has expired');
    expect(problems[0]!.link).toMatch(/^\/settings\/workspace\/runners\?signin=/);
    expect(problems[1]!.text).toContain('Acme models');
    expect(JSON.stringify(problems)).not.toContain('Quiet');

    const member = await w.call(nadia, 'GET', '/api/admin/attention');
    expect(member.status).toBe(200);
    expect(GetAttentionResponse.parse(member.body).problems).toEqual([]);

    // a changed key makes the failed test history: the bar no longer names it
    await w.system((tx) => tx.query('UPDATE app.llm_providers SET updated_at = now() + interval \'1 second\' WHERE id = $1', [provider]));
    const after = GetAttentionResponse.parse((await w.call(omar, 'GET', '/api/admin/attention')).body).problems;
    expect(after.map((p) => p.kind)).toEqual(['runner_sign_in']);
  });
});
