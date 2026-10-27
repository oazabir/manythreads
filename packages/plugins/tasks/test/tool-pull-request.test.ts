import type { PluginContext, PluginTx, ProjectCredentialsProvider } from '@manythreads/sdk';
import { startFakeGithub, type FakeGithub } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerCapabilities } from '../src/capabilities.ts';

// `tasks.pull_request`: the tool a bot calls to record the pull request it opened. The bot says only the project and the number; the SERVER asks GitHub
// (with the project's own token) and insists the pull request is open, from this card's branch, at the tested commit, inside the project's repository
// (so a bot cannot finish a card with a pull request it made up, or one made by someone else), then hands the verified facts to the one SQL door.
// The database is a stub answering by SQL (the door's own rules are tested against the real database in pull-request.test.ts); GitHub is a local double.

const ME = '01a16e30-0000-7000-8000-0000000000a1';
const TASK = '01a16e30-0000-7000-8000-0000000000b1';
const TEAM = '01a16e30-0000-7000-8000-0000000000c2';
const BRANCH = 'card-01a16e30';
const SHA = 'c'.repeat(40);
const TOKEN = 'ghp_ToolTestToken0123456789abcdefgh';
const ORIGIN = 'https://github.com/acme/widgets';
const ENV = ['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW', 'MANYTHREADS_TEST_GITHUB_API'];
const saved: Record<string, string | undefined> = {};

let gh: FakeGithub;
beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  gh = await startFakeGithub({ token: TOKEN, owner: 'acme', repo: 'widgets' });
  process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW'] = 'https://github.com/acme/';
  process.env['MANYTHREADS_TEST_GITHUB_API'] = gh.url;
});
afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await gh.stop();
});

async function openPull(over: { head?: string; sha?: string; headRepo?: string; base?: string } = {}): Promise<number> {
  const r = await fetch(`${gh.url}/repos/acme/widgets/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 't', head: over.head ?? BRANCH, base: over.base ?? 'main', head_sha: over.sha ?? SHA, ...(over.headRepo ? { head_repo: over.headRepo } : {}) }),
  });
  return ((await r.json()) as { number: number }).number;
}

function harness(opts: { door?: { o_outcome: string; o_reason: string }; credential?: { token: string; origin: string; branch: string } | null; owner?: string } = {}) {
  const door = opts.door ?? { o_outcome: 'recorded', o_reason: '' };
  const sql: { text: string; params: unknown[] }[] = [];
  const emitted: unknown[] = [];
  const handlers = new Map<string, (input: Record<string, unknown>, tx: PluginTx) => Promise<Record<string, unknown>>>();
  let recorded = false;
  const query = (text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    sql.push({ text, params });
    if (text.includes('app.tasks_record_pull_request')) {
      recorded = door.o_outcome === 'recorded';
      return Promise.resolve({ rows: [door] });
    }
    if (text.includes('FROM app.teams')) return Promise.resolve({ rows: [{ slug: 'engineering' }] });
    if (text.includes('FROM app.tasks t')) {
      const now = new Date('2026-10-27T10:00:00Z');
      return Promise.resolve({
        rows: [
          {
            id: TASK, workspace_id: '01a16e30-0000-7000-8000-0000000000c1', team_id: TEAM, goal_id: null, title: 'Fix', description: '',
            state: recorded ? 'waiting_on_person' : 'in_progress', kind: 'code', priority: 'normal', owner_id: opts.owner ?? ME, branch: BRANCH, base_sha: null,
            tested_sha: recorded ? SHA : null, environment_id: null, board_id: null, thread_root_id: null,
            blocker_reason: recorded ? 'Pull request waits for a person to merge it' : '', rework_count: 0, handoff_count: 0, created_by: ME, created_at: now, updated_at: now, completed_at: null,
            pull_request_project: recorded ? 'widgets' : null, pull_request_number: recorded ? 7 : null, pull_request_url: recorded ? `${ORIGIN}/pull/7` : null,
            pull_request_state: recorded ? 'open' : null, pull_request_merge_sha: null,
          },
        ],
      });
    }
    return Promise.resolve({ rows: [] });
  };
  const tx = { actor: { id: ME, kind: 'bot', workspaceId: 'w' }, query } as unknown as PluginTx;
  const credentials: ProjectCredentialsProvider = {
    id: 'project.credentials',
    put: async () => undefined,
    remove: async () => undefined,
    read: async () => (opts.credential === undefined ? { token: TOKEN, origin: ORIGIN, branch: 'main' } : opts.credential),
  };
  const ctx = {
    capabilities: { register: (n: string, fn: never) => handlers.set(n, fn) },
    audit: { emit: async (_tx: PluginTx, e: unknown) => void emitted.push(e) },
    providers: { get: () => credentials },
  } as unknown as PluginContext;
  registerCapabilities(ctx);
  return { sql, emitted, run: (input: Record<string, unknown>) => handlers.get('tasks.pull_request')!(input, tx) };
}

const asked = (n: number) => ({ taskId: TASK, project: 'widgets', testedSha: SHA, number: n });

describe('tasks.pull_request', () => {
  it('asks GitHub, then records the pull request through the door with an address the server made, and announces the card as updated', async () => {
    const n = await openPull();
    const h = harness();
    expect(await h.run(asked(n))).toMatchObject({ ok: true, taskId: TASK, number: n, state: 'waiting_on_person' });
    const door = h.sql.find((s) => s.text.includes('tasks_record_pull_request'))!;
    expect(door.params).toEqual([TASK, SHA, 'widgets', n, `${ORIGIN}/pull/${n}`, ORIGIN, BRANCH, SHA, 'main']);
    expect(h.emitted[0]).toMatchObject({ type: 'tasks.task.updated', taskId: TASK, state: 'waiting_on_person', fromState: 'in_progress', testedSha: SHA });
    expect(gh.calls.at(-1)).toMatchObject({ method: 'GET', authorized: true });
  });

  it('refuses a pull request that is not the card’s: wrong branch, wrong commit, from a fork, merged, closed, unknown', async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['wrong branch', { n: await openPull({ head: 'card-99999999' }) }, 'wrong_branch'],
      ['wrong commit', { n: await openPull({ sha: 'd'.repeat(40) }) }, 'sha_mismatch'],
      ['into another branch', { n: await openPull({ base: 'next' }) }, 'wrong_base'],
      ['from a fork', { n: await openPull({ headRepo: 'mallory/widgets' }) }, 'wrong_repository'],
    ];
    for (const [name, c, code] of cases) {
      const h = harness();
      expect(await h.run(asked(c['n'] as number)), name).toMatchObject({ ok: false, code });
      expect(h.sql.some((s) => s.text.includes('tasks_record_pull_request')), name).toBe(false);
    }
    const merged = await openPull();
    gh.merge(merged, 'e'.repeat(40));
    expect(await harness().run(asked(merged))).toMatchObject({ ok: false, code: 'not_open' });
    const closed = await openPull();
    gh.close(closed);
    expect(await harness().run(asked(closed))).toMatchObject({ ok: false, code: 'not_open' });
    expect(await harness().run(asked(99999))).toMatchObject({ ok: false, code: 'github_unreachable' });
  });

  it('refuses without a credential, for an address it may not call, and for a card the caller does not own — asking GitHub nothing', async () => {
    const n = await openPull();
    const before = gh.calls.length;
    expect(await harness({ credential: null }).run(asked(n))).toMatchObject({ ok: false, code: 'no_credential' });
    expect(await harness({ credential: { token: TOKEN, origin: 'https://gitlab.example/acme/widgets', branch: 'main' } }).run(asked(n))).toMatchObject({ ok: false, code: 'no_credential' });
    expect(await harness({ owner: '01a16e30-0000-7000-8000-0000000000ff' }).run(asked(n))).toMatchObject({ ok: false, code: 'not_owner' });
    expect(gh.calls.length).toBe(before);
  });

  it('answers a refusal of the door as data, with nothing announced', async () => {
    const n = await openPull();
    for (const [outcome, reason] of [['not_owner', 'only the owner'], ['already_open', 'pull request #7 is already open']] as const) {
      const h = harness({ door: { o_outcome: outcome, o_reason: reason } });
      expect(await h.run(asked(n))).toEqual({ ok: false, code: outcome, message: reason });
      expect(h.emitted).toEqual([]);
    }
  });

  it('refuses input that is not well formed — including an address from the bot — before anything is asked', async () => {
    const good = asked(1);
    const bad: Record<string, unknown>[] = [
      { ...good, taskId: 'card-1' },
      { ...good, testedSha: 'HEAD' },
      { ...good, number: 0 },
      { ...good, number: '7' },
      { ...good, project: '../x' },
      { ...good, url: 'https://github.com/mallory/evil/pull/1' },
      { taskId: TASK },
    ];
    const before = gh.calls.length;
    for (const input of bad) {
      const h = harness();
      expect(await h.run(input), JSON.stringify(input).slice(0, 60)).toMatchObject({ ok: false, code: 'invalid_input' });
      expect(h.sql).toEqual([]);
    }
    expect(gh.calls.length).toBe(before);
  });
});
