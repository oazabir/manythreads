import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { madeUpClaudeSignin, ownerSql, seedRunners, seedWorld, SEED_RUNNERS, startFakeK8s, startTestServer, type FakeK8s, type SeedRunnersResult, type TestServer } from '../src/index.ts';

// Seed v19 (PLAN P19-11) end to end: a real server and database, the seed's own routes, and a stand-in of the Kubernetes API for the Claude sign-in Secrets. The seed is opt-in:
// nothing in the default world has a runner.
let server: TestServer;
let k8s: FakeK8s;
let storageDir: string;
let first: SeedRunnersResult;
const saved = process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'];
const sql = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> => ownerSql<T>(server.db.ownerUrl, text, params);
const secretOf = (name: string) => k8s.secrets.get(`manythreads-bots/claude-${name}-credentials`);

beforeAll(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'manythreads-seed19-blobs-'));
  process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
  k8s = await startFakeK8s();
  process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'] = k8s.url;
  server = await startTestServer();
  await seedWorld(server.db, { content: true, repo: true });
  // the default world has no runner (the seed is opt-in)
  expect(await sql(`SELECT 1 FROM app.bot_runners`)).toEqual([]);
  first = await seedRunners({ url: server.url, db: server.db });
}, 300_000);

afterAll(async () => {
  await server?.close();
  await k8s?.stop();
  if (saved === undefined) delete process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'];
  else process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'] = saved;
  rmSync(storageDir, { recursive: true, force: true });
});

describe('seedRunners (seed v19)', () => {
  it('makes the five runners, with the kinds, teams and states the Runners page shows', async () => {
    const rows = await sql<{ name: string; kind: string; status: string; all_teams: boolean; model_alias: string | null; enabled: boolean }>(
      `SELECT name, kind, status, all_teams, model_alias, enabled FROM app.bot_runners ORDER BY name`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by['office-hermes']).toMatchObject({ kind: 'hermes_gateway', all_teams: true, enabled: true });
    expect(by['team-pods']).toMatchObject({ kind: 'hermes_pod', all_teams: true });
    expect(by['claude-shared']).toMatchObject({ kind: 'claude_cli', status: 'ready', all_teams: false });
    expect(by['claude-support']).toMatchObject({ kind: 'claude_cli', status: 'ready', all_teams: false });
    expect(by['fast-gateway']).toMatchObject({ kind: 'llm_gateway', model_alias: 'fast', all_teams: true });
    expect(first.runners.host?.name).toBe('office-hermes');
    expect(Object.keys(first.runners).sort()).toEqual(expect.arrayContaining(['claudeShared', 'claudeSupport', 'gateway', 'host', 'teamPod']));
  });

  it('shares one Claude runner between Engineering and Marketing and gives Customer support its own', async () => {
    const teams = async (runner: string): Promise<string[]> =>
      (await sql<{ slug: string }>(`SELECT t.slug FROM app.bot_runner_teams rt JOIN app.bot_runners r ON r.id = rt.runner_id JOIN app.teams t ON t.id = rt.team_id WHERE r.name = $1 ORDER BY t.slug`, [runner])).map((r) => r.slug);
    expect(await teams('claude-shared')).toEqual(['engineering', 'marketing']);
    expect(await teams('claude-support')).toEqual(['customer-support']);
  });

  it('makes a Codex runner waiting for a sign-in when this build lets an admin make one, and says so when it does not', async () => {
    const rows = await sql<{ kind: string; status: string }>(`SELECT kind, status FROM app.bot_runners WHERE name = $1`, [SEED_RUNNERS.runners.codex.name]);
    if (first.runners.codex === undefined) expect(rows).toEqual([]);
    else expect(rows).toEqual([{ kind: 'codex_cli', status: 'waiting_for_sign_in' }]);
  });

  it('places one bot on each runner through its BOT.md, and the loader accepts every one', async () => {
    const bots = await sql<{ slug: string; status: string; runs_on: string | null }>(`SELECT slug, status, placement ->> 'runs_on' AS runs_on FROM app.bots WHERE slug = ANY($1::text[]) ORDER BY slug`, [SEED_RUNNERS.bots.map((b) => b.slug)]);
    const expected = first.bots.map((b) => ({ slug: b.slug, status: 'active', runs_on: b.runner })).sort((a, b) => a.slug.localeCompare(b.slug));
    expect(bots).toEqual(expected);
    // the five runners that exist in every build have a bot
    for (const name of ['office-hermes', 'team-pods', 'claude-shared', 'claude-support', 'fast-gateway']) expect(bots.some((b) => b.runs_on === name)).toBe(true);
  });

  it('puts each Claude login in its own pod Secret byte for byte, different logins, and nothing of them in the database', async () => {
    const shared = Buffer.from(secretOf('claude-shared')!.data!['.credentials.json']!, 'base64').toString('utf8');
    const support = Buffer.from(secretOf('claude-support')!.data!['.credentials.json']!, 'base64').toString('utf8');
    expect(shared).toContain(SEED_RUNNERS.canary);
    expect(JSON.parse(shared).claudeAiOauth.refreshToken).not.toBe(JSON.parse(support).claudeAiOauth.refreshToken);
    expect(JSON.parse(shared).claudeAiOauth.accessToken).toMatch(/^fake-/);
    const row = (await sql<{ credentials_sha256: string }>(`SELECT credentials_sha256 FROM app.bot_runners WHERE name = 'claude-shared'`))[0]!;
    expect(row.credentials_sha256).toBe(createHash('sha256').update(shared).digest('hex'));
    // the canary is in no table of the runner catalog, no audit row, no event and no log line
    const runners = JSON.stringify(await sql(`SELECT * FROM app.bot_runners`));
    expect(runners).not.toContain(SEED_RUNNERS.canary);
    expect(JSON.stringify(await sql(`SELECT * FROM app.audit_events`))).not.toContain(SEED_RUNNERS.canary);
    expect(server.logs.join('\n')).not.toContain(SEED_RUNNERS.canary);
  });

  it('is idempotent: a second run makes no runner, no bot and no second upload', async () => {
    const runnersBefore = await sql(`SELECT id, updated_at FROM app.bot_runners ORDER BY id`);
    const botsBefore = await sql(`SELECT id FROM app.bots WHERE slug = ANY($1::text[]) ORDER BY id`, [SEED_RUNNERS.bots.map((b) => b.slug)]);
    const secretsBefore = JSON.stringify([...k8s.secrets.entries()]);
    const again = await seedRunners({ url: server.url, db: server.db });
    expect(again.runners).toEqual(first.runners);
    expect(again.bots).toEqual(first.bots);
    expect(await sql(`SELECT id, updated_at FROM app.bot_runners ORDER BY id`)).toEqual(runnersBefore);
    expect(await sql(`SELECT id FROM app.bots WHERE slug = ANY($1::text[]) ORDER BY id`, [SEED_RUNNERS.bots.map((b) => b.slug)])).toEqual(botsBefore);
    expect(JSON.stringify([...k8s.secrets.entries()])).toBe(secretsBefore);
  });
});

describe('the made-up sign-in file', () => {
  it('has the shape of the real file with canary strings, different logins for different tags, and a fresh expiry', () => {
    const a = JSON.parse(madeUpClaudeSignin('a', 1_000));
    const b = JSON.parse(madeUpClaudeSignin('b', 1_000));
    expect(a.claudeAiOauth.scopes).toContain('user:inference');
    expect(a.claudeAiOauth.expiresAt).toBe(1_000 + 8 * 3600_000);
    expect(a.claudeAiOauth.refreshToken).not.toBe(b.claudeAiOauth.refreshToken);
    expect(madeUpClaudeSignin('a')).toContain(SEED_RUNNERS.canary);
  });

  it('reads no real sign-in: nothing in the seed or this test names the home folder', () => {
    for (const file of [fileURLToPath(new URL('../src/seed-runners.ts', import.meta.url)), fileURLToPath(import.meta.url)]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/process\.env\.HOME|\bhomedir\(|~\/\.(claude|codex)|\/\.claude\/\.credentials|\/\.codex\/auth/);
    }
  });
});

describe('a server without the Claude pods plugin', () => {
  it('refuses the Claude runners and the seed says why in plain words', async () => {
    delete process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'];
    const plain = await startTestServer();
    try {
      await seedWorld(plain.db, { content: true, repo: true });
      await expect(seedRunners({ url: plain.url, db: plain.db })).rejects.toThrow(/no Claude pods plugin/);
    } finally {
      await plain.close();
      process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'] = k8s.url;
    }
  }, 180_000);
});
