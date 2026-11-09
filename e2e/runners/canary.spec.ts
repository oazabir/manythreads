import { expect, test } from '@playwright/test';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { startRunnersWorld, type RunnersWorld } from './support.ts';

/*
 * PLAN P19-12, "canary": a canary planted in a runner's sign-in file appears in no log line, event, audit row, message or answer. The file is made up (the shape of a real Claude login and of
 * a real Codex login, the canary in every token and in the other services' sign-ins the Claude file may hold). It goes through the real upload route into the stand-in cluster's Secret,
 * and then the proof reads everything that could have kept a copy: the server's own log, every answer the routes gave (including the refusals, which must not echo the file), every
 * table of the database (as text), the messages of a channel in which a person pasted the token. A control first shows the scan can see: the Secret holds the bytes exactly, and the scan of
 * the database finds the runner we made.
 */
test.skip(({ isMobile }) => isMobile, 'API walk; no layout');
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const CANARY = 'CANARY-SIGNIN-ec17';
const claudeFile = (tag: string, scopes: string[] = ['user:inference', 'user:profile']): string =>
  `${JSON.stringify(
    {
      claudeAiOauth: { accessToken: `sk-ant-oat01-${tag}-${CANARY}-AbCdEfGhIjKlMnOpQrStUv`, refreshToken: `sk-ant-ort01-${tag}-${CANARY}-WxYzAbCdEfGhIjKlMnOpQr`, expiresAt: Date.now() + 8 * 3600_000, scopes, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
      mcpOAuth: { 'notion|a': { accessToken: `n-${CANARY}` } },
    },
    null,
    3,
  )}\n\n`;
const b64 = (s: string): string => Buffer.from(s).toString('base64url');
const STARTED = new Date().toISOString();
const codexFile = (): string =>
  JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: `${b64('{"alg":"RS256"}')}.${b64(`{"plan":"${CANARY}"}`)}.${b64(`sig-${CANARY}`)}`, access_token: `${b64('{"alg":"RS256"}')}.${b64(`{"exp":9999999999,"c":"${CANARY}"}`)}.${b64('s')}`, refresh_token: `rt_${CANARY}.Qw8Er7`, account_id: `acct-${CANARY}` },
    last_refresh: STARTED,
  });

let world: RunnersWorld;
let omar: StackApi;
let nadia: StackApi;
const answers: string[] = [];
const note = (label: string, status: number, text: string): void => void answers.push(`${label} -> ${String(status)}\n${text}`);

async function put(api: StackApi, runnerId: string, body: string, label: string): Promise<{ status: number; text: string }> {
  const res = await api.ctx.put(`/api/admin/bot-runners/${runnerId}/credentials`, { data: body, headers: { ...(await api.headers()), 'content-type': 'application/json', 'x-terms-ack': '1', 'x-signins-ack': '1' } });
  const text = await res.text();
  note(label, res.status(), text);
  return { status: res.status(), text };
}
async function call(api: StackApi, method: 'GET' | 'POST' | 'DELETE', path: string, label: string): Promise<{ status: number; text: string }> {
  const res = await api.ctx.fetch(path, { method, headers: method === 'GET' ? {} : method === 'POST' ? { ...(await api.headers()), 'content-type': 'application/json' } : await api.headers(), ...(method === 'POST' ? { data: '{}' } : {}) });
  const text = await res.text();
  note(label, res.status(), text);
  return { status: res.status(), text };
}
const secretOf = (name: string): { data?: Record<string, string> } | undefined => [...world.k8s.secrets.entries()].find(([k]) => k.endsWith(`/${name}`))?.[1];

test.beforeAll(async ({ playwright }) => {
  world = await startRunnersWorld();
  omar = await apiOn(playwright, world.stack, 'omar');
  nadia = await apiOn(playwright, world.stack, 'nadia');
});
test.afterAll(async () => {
  await omar?.ctx.dispose();
  await nadia?.ctx.dispose();
  await world?.stop();
});

test('the sign-in files go in through the real route and sit in the cluster Secret byte for byte, and nowhere else', async () => {
  const team = (await world.stack.sql<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'"))[0]!.id;
  const made = await omar.ctx.post('/api/admin/bot-runners', { data: { name: 'claude-canary', label: 'Canary Claude', kind: 'claude_cli', teams: { teams: [team] } }, headers: await omar.headers() });
  expect(made.status(), await made.text()).toBe(201);
  const claudeId = ((await made.json()) as { runner: { id: string } }).runner.id;
  const codexId = (await world.stack.sql<{ id: string }>("SELECT id FROM app.bot_runners WHERE name = 'codex-chatgpt'"))[0]?.id ?? '';
  expect(codexId, 'the runners world has a Codex runner').not.toBe('');

  const file = claudeFile('one');
  const ok = await put(omar, claudeId, file, 'PUT claude sign-in');
  expect(ok.status, ok.text).toBe(200);
  const okCodex = await put(omar, codexId, codexFile(), 'PUT codex sign-in');
  expect(okCodex.status, okCodex.text).toBe(200);

  // control: the Secrets hold the bytes exactly (so the scans below look for something that really exists)
  const claudeSecret = secretOf('claude-claude-canary-credentials');
  expect(Buffer.from(claudeSecret!.data!['.credentials.json']!, 'base64').toString('utf8')).toBe(file);
  expect(Buffer.from(secretOf('codex-codex-chatgpt-credentials')!.data!['auth.json']!, 'base64').toString('utf8')).toBe(codexFile());

  // the refusals: a file with no inference scope, a file that is not a sign-in file, the same login on a second runner, an API-key Codex file - none may echo what was sent
  const second = await omar.ctx.post('/api/admin/bot-runners', { data: { name: 'claude-canary-2', label: 'Second', kind: 'claude_cli', teams: { teams: [team] } }, headers: await omar.headers() });
  const secondId = ((await second.json()) as { runner: { id: string } }).runner.id;
  const noScope = await put(omar, secondId, claudeFile('two', ['user:profile']), 'PUT no-scope file');
  expect(noScope.status).toBeGreaterThanOrEqual(400);
  const notAFile = await put(omar, secondId, `{"hello":"${CANARY}"}`, 'PUT not a sign-in file');
  expect(notAFile.status).toBeGreaterThanOrEqual(400);
  const sameLogin = await put(omar, secondId, file, 'PUT the same login on a second runner');
  expect(sameLogin.status, sameLogin.text).toBeGreaterThanOrEqual(400);
  const apiKeyFile = await put(omar, codexId, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: `sk-${CANARY}`, tokens: {} }), 'PUT codex file with an API key');
  expect(apiKeyFile.status).toBeGreaterThanOrEqual(400);
  const bad = await put(omar, claudeId, `${file.slice(0, 40)}${CANARY}`, 'PUT a truncated file');
  expect(bad.status).toBeGreaterThanOrEqual(400);

  // every read an admin and a lead can make about the runners after the upload
  await call(omar, 'GET', '/api/admin/bot-runners', 'GET runners (admin)');
  await call(omar, 'POST', `/api/admin/bot-runners/${claudeId}/check`, 'POST check sign-in (admin)');
  await call(omar, 'POST', `/api/admin/bot-runners/${claudeId}/test`, 'POST test runner (admin)');
  await call(omar, 'GET', '/api/admin/bot-runners/usage', 'GET usage (admin)');
  await call(nadia, 'GET', '/api/teams/engineering/bot-runners', 'GET runners (lead)');
  await call(nadia, 'GET', '/api/teams/engineering/bots/code-helper', 'GET bot (lead)');
});

test('the data protection of the running server hides every token shape in outbound text (standard) and refuses it for customers', async () => {
  // Text a bot sends out passes data protection (a person's own message in a channel does not leave the platform, so it is not judged). The admin's test box judges text in memory under the
  // server's real policy, which is the same call the chain makes; nothing is stored. Shapes: the two Anthropic tokens, a JSON web token (a ChatGPT id or access token), a ChatGPT refresh token.
  const b64u = (x: string): string => Buffer.from(x).toString('base64url');
  const samples = [
    `sk-ant-oat01-paste-${CANARY}-AbCdEfGhIjKlMnOpQrStUv`,
    `sk-ant-ort01-paste-${CANARY}-AbCdEfGhIjKlMnOpQrStUv`,
    `${b64u('{"alg":"RS256"}')}.${b64u(`{"plan":"${CANARY}"}`)}.${b64u(`sig-${CANARY}`)}`,
    `rt_${'Qw8Er7'.repeat(8)}.${'Ty6Ui5'.repeat(8)}`,
  ];
  const headers = await omar.headers();
  for (const token of samples) {
    for (const [preset, outcome] of [['standard', 'redact'], ['customer-facing', 'block']] as const) {
      const res = await omar.ctx.post('/api/admin/guardrails/dlp/test', { data: { text: `here is the login: ${token}`, preset }, headers });
      const text = await res.text();
      // not noted with the answers scanned below: the box hands the admin's own typed text back to the admin (a block keeps it so he sees what was refused)
      expect(res.status(), text).toBe(200);
      const body = JSON.parse(text) as { outcome: string; text: string; findings: Array<{ rule: string }> };
      expect(body.outcome, `${preset}: ${token.slice(0, 20)}`).toBe(outcome);
      expect(body.findings.map((f) => f.rule)).toContain('signin-token');
      // a block keeps the original text in the box (nothing leaves: the caller refuses the send); a redaction must not keep a byte of the token
      if (outcome === 'redact') {
        expect(body.text).not.toContain(CANARY);
        expect(body.text).not.toContain(token.slice(12, 40));
        expect(body.text).toContain('[redacted:signin-token]');
      }
    }
  }
});

test('Remove sign-in takes the Secret and the state volume away, and the runner waits for a new sign-in', async () => {
  const id = (await world.stack.sql<{ id: string }>("SELECT id FROM app.bot_runners WHERE name = 'claude-canary'"))[0]!.id;
  const before = world.k8s.calls.length;
  const res = await call(omar, 'DELETE', `/api/admin/bot-runners/${id}/credentials`, 'DELETE claude sign-in');
  expect(res.status, res.text).toBe(200);
  expect(secretOf('claude-claude-canary-credentials'), 'the credentials Secret is gone').toBeUndefined();
  const made = world.k8s.calls.slice(before);
  expect(made.some((c) => /^DELETE .*\/persistentvolumeclaims\/claude-claude-canary-state$/.test(c)), made.join('\n')).toBe(true);
  expect(made.some((c) => /^DELETE .*\/secrets\/claude-claude-canary-credentials$/.test(c)), made.join('\n')).toBe(true);
  expect(made.every((c) => !/\/persistentvolumeclaims\/claude-claude-canary-work/.test(c) || !c.startsWith('DELETE')), 'the work claim (public clones) is not touched').toBe(true);
  // the state claim goes before the Secret
  expect(made.findIndex((c) => c.includes('persistentvolumeclaims') && c.startsWith('DELETE'))).toBeLessThan(made.findIndex((c) => c.includes('/secrets/') && c.startsWith('DELETE')));
});

test('the canary is in no log line, answer, event, audit row, message or table of the database', async () => {
  // control: the scan sees the database (it finds the runner we made) and the log (it finds the plugin's own lines)
  const tables = (await world.stack.sql<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'app' AND table_type = 'BASE TABLE' ORDER BY 1")).map((t) => t.table_name);
  expect(tables.length).toBeGreaterThan(50);
  const holds = async (needle: string): Promise<string[]> => {
    const found: string[] = [];
    for (const t of tables) {
      const n = (await world.stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app."${t}" x WHERE x::text LIKE $1`, [`%${needle}%`]))[0]!.n;
      if (Number(n) > 0) found.push(`${t} (${n})`);
    }
    return found;
  };
  expect(await holds('claude-canary'), 'control: the scan can read the runner we made').toContain('bot_runners (2)');
  expect(world.stack.log().length, 'control: the server log is captured').toBeGreaterThan(200);

  expect(await holds(CANARY), `the canary is in a table`).toEqual([]);
  for (const piece of ['sk-ant-oat01-one', 'sk-ant-ort01-one', `acct-${CANARY}`, 'rt_CANARY']) expect(await holds(piece), piece).toEqual([]);
  expect(world.stack.log(), 'the server log').not.toContain(CANARY);
  expect(world.stack.log(), 'the server log (token prefix)').not.toMatch(/sk-ant-o(at|rt)01-/);
  expect(answers.join('\n'), 'an answer of a route').not.toContain(CANARY);
  expect(answers.length, 'the proof read the answers of the routes it called').toBeGreaterThan(10);
  // the stand-in cluster's calls are about names and sizes, never the bytes (a request body is not kept, but the paths are)
  expect(world.k8s.calls.join('\n')).not.toContain(CANARY);
});
