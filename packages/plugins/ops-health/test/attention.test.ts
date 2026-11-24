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
      await tx.query(`INSERT INTO app.bot_runners (workspace_id, name, label, kind, status) VALUES ($1, 'claude-x', 'Claude X', 'claude_cli', 'needs_sign_in'), ($1, 'quiet', 'Quiet', 'claude_cli', 'ready'), ($1, 'codex-w', 'Codex W', 'codex_cli', 'waiting_for_sign_in'), ($1, 'restarting', 'Restarting', 'codex_cli', 'waiting_for_sign_in')`, [ws]);
      await tx.query(`UPDATE app.bot_runners SET updated_at = now() - interval '10 minutes' WHERE workspace_id = $1 AND name = 'codex-w'`, [ws]);
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
    expect(problems.map((p) => p.kind)).toEqual(['runner_sign_in', 'runner_sign_in', 'model_key']);
    expect(problems[1]!.text).toContain('Runner “Codex W” is not signed in to Codex');
    expect(problems[0]!.text).toContain('Claude Code sign-in of runner “Claude X” has expired');
    expect(problems[0]!.link).toMatch(/^\/settings\/workspace\/runners\?signin=/);
    expect(problems[2]!.text).toContain('Acme models');
    expect(JSON.stringify(problems)).not.toContain('Quiet');
    // a runner that only just started waiting (a pod restarting) is not named yet
    expect(JSON.stringify(problems)).not.toContain('Restarting');

    const member = await w.call(nadia, 'GET', '/api/admin/attention');
    expect(member.status).toBe(200);
    expect(GetAttentionResponse.parse(member.body).problems).toEqual([]);

    // a changed key makes the failed test history: the bar no longer names it
    await w.system((tx) => tx.query('UPDATE app.llm_providers SET updated_at = now() + interval \'1 second\' WHERE id = $1', [provider]));
    const after = GetAttentionResponse.parse((await w.call(omar, 'GET', '/api/admin/attention')).body).problems;
    expect(after.map((p) => p.kind)).toEqual(['runner_sign_in', 'runner_sign_in']);
  });

  it('names a team of a per-team runner whose own sign-in is gone and that has a bot there, with a link to that team; not the runner as a whole', async () => {
    const ids = await w.system(async (tx) => {
      const ws = (await tx.query<{ id: string }>('SELECT id FROM app.workspaces ORDER BY id LIMIT 1')).rows[0]!.id;
      const team = (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id;
      const other = (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'marketing'")).rows[0]!.id;
      const runner = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runners (workspace_id, name, label, kind, status, sign_in_scope, all_teams, updated_at) VALUES ($1, 'each-codex', 'Each Codex', 'codex_cli', 'waiting_for_sign_in', 'per_team', true, now() - interval '1 hour') RETURNING id`,
          [ws],
        )
      ).rows[0]!.id;
      await tx.query(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
         VALUES ($1, $2, 'each-bot', 'Each bot', '', 'agent', 'hermes', 'team', repeat('e', 64), 'active', '{"runs_on":"each-codex"}'::jsonb)`,
        [ws, team],
      );
      const support = (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'customer-support'")).rows[0]!.id;
      await tx.query(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
         VALUES ($1, $2, 'each-bot', 'Each bot', '', 'agent', 'hermes', 'team', repeat('e', 64), 'active', '{"runs_on":"each-codex"}'::jsonb)`,
        [ws, support],
      );
      // marketing is signed out too, but has no bot on the runner: nothing of it stops. Support's sign-in was refused by a run.
      await tx.query(`INSERT INTO app.bot_runner_team_signins (runner_id, team_id, state) VALUES ($1, $2, 'signed_out'), ($1, $3, 'signed_out'), ($1, $4, 'refused')`, [runner, team, other, support]);
      return { runner, team, support };
    });
    const { problems } = GetAttentionResponse.parse((await w.call(omar, 'GET', '/api/admin/attention')).body);
    const mine = problems.filter((p) => p.key.startsWith(`runner:${ids.runner}`));
    expect(mine).toEqual([
      {
        kind: 'runner_sign_in',
        key: `runner:${ids.runner}:team:${ids.support}`,
        text: 'The Codex sign-in of team “Customer support” on runner “Each Codex” has expired or was refused. Its bots on that runner cannot work until someone signs the team in again.',
        link: `/settings/workspace/runners?signin=${ids.runner}&team=customer-support`,
        action: 'Sign in',
      },
      {
        kind: 'runner_sign_in',
        key: `runner:${ids.runner}:team:${ids.team}`,
        text: 'Team “Engineering” is not signed in to Codex on runner “Each Codex”. Its bots on that runner cannot work until someone signs the team in.',
        link: `/settings/workspace/runners?signin=${ids.runner}&team=engineering`,
        action: 'Sign in',
      },
    ]);
    expect(GetAttentionResponse.parse((await w.call(nadia, 'GET', '/api/admin/attention')).body).problems).toEqual([]);
  });
});
