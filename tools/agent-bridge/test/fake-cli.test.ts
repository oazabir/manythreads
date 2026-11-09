/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON lines and JSON-RPC bodies of many shapes */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { events, harness, start, type Harness } from './support.ts';

// P19-11: the stand-in `claude` and `codex` of the claude-pod-fake image (deploy/images/claude-pod-fake), run under the REAL bridge. They must speak the whole of the real
// commands' JSON lines, call the run's MCP address for real (a local MCP stand-in below sees `initialize`, `tools/list`, `tools/call`), and be steerable into a refused sign-in, a plan
// limit and a renewed sign-in file. Nothing here reads the operator's own Claude or Codex folders: every path is under a made-up folder.

const here = dirname(fileURLToPath(import.meta.url));
const IMAGE = join(here, '..', '..', '..', 'deploy', 'images', 'claude-pod-fake');
const STAND_IN_CLAUDE = join(IMAGE, 'fake-claude.mjs');
const STAND_IN_CODEX = join(IMAGE, 'fake-codex.mjs');
const TOKEN = 'run-token-CANARY-4471';
const CANARY = 'CANARY-SIGNIN-5a2e';

let h: Harness | undefined;
let mcp: McpStandIn;
let tmp: string;
const dirs: string[] = [];
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'fake-cli-'));
  dirs.push(tmp);
  mcp = await startMcp();
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  await mcp.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface McpCall {
  method: string;
  auth: string | undefined;
  session: string | undefined;
  params: any;
}
interface McpStandIn {
  url: string;
  calls: McpCall[];
  stop(): Promise<void>;
}

/** A local MCP endpoint: plain JSON-RPC over POST like the platform's (`initialize` hands out a session id; `notifications/*` answer 202). */
async function startMcp(): Promise<McpStandIn> {
  const calls: McpCall[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      calls.push({ method: rpc.method, auth: req.headers.authorization, session: req.headers['mcp-session-id'] as string | undefined, params: rpc.params });
      if (String(rpc.method).startsWith('notifications/')) {
        res.writeHead(202).end();
        return;
      }
      const reply = (result: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      };
      if (rpc.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '0' } }, { 'mcp-session-id': 'sess-1' });
      else if (rpc.method === 'tools/list') reply({ tools: [{ name: 'messages.post', inputSchema: { type: 'object' } }, { name: 'messages.search', inputSchema: { type: 'object' } }] });
      else if (rpc.method === 'tools/call') {
        if (rpc.params.name === 'broken.tool') reply({ content: [{ type: 'text', text: 'refused' }], isError: true });
        else reply({ content: [{ type: 'text', text: `done ${rpc.params.name}` }] });
      } else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'no such method' } }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    calls,
    stop: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

const folder = (name: string): string => {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A made-up Claude sign-in file with odd whitespace and a trailing newline; returns the folder. */
function claudeFolder(over: { expiresInMs?: number; access?: string } = {}): string {
  const dir = folder('claude');
  const body = { claudeAiOauth: { accessToken: over.access ?? `fake-access-${CANARY}`, refreshToken: `fake-refresh-${CANARY}`, expiresAt: Date.now() + (over.expiresInMs ?? 8 * 3600_000), scopes: ['user:inference'] }, unknownFutureKey: { keep: true } };
  writeFileSync(join(dir, '.credentials.json'), `${JSON.stringify(body, null, 3).replace('"unknownFutureKey":', '"unknownFutureKey" :')}\n\n`, { mode: 0o600 });
  return dir;
}

/** A made-up Codex auth.json (the key names of the real file, no value read from a real one). */
function codexFolder(over: Record<string, unknown> = {}, lastRefresh = new Date().toISOString()): string {
  const dir = folder('codex');
  const body = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: `fake-id-${CANARY}`, access_token: `fake-access-${CANARY}`, refresh_token: 'fake-refresh-r0', account_id: 'acct-canary' }, last_refresh: lastRefresh, ...over };
  writeFileSync(join(dir, 'auth.json'), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return dir;
}

const claudeHarness = async (dir: string, env: Record<string, string> = {}, serverOpts: Parameters<typeof harness>[2] = {}): Promise<Harness> => {
  const hh = await harness({ bin: { claude: STAND_IN_CLAUDE, codex: STAND_IN_CODEX } }, 'claude-code', serverOpts);
  hh.config.profiles['default']!.env = { CLAUDE_CONFIG_DIR: dir, FAKE_MODE_FILE: join(tmp, 'fake-mode'), ...env };
  return hh;
};
const codexHarness = async (dir: string, env: Record<string, string> = {}): Promise<Harness> => {
  const hh = await harness({ bin: { claude: STAND_IN_CLAUDE, codex: STAND_IN_CODEX } }, 'codex');
  hh.config.profiles['default']!.env = { CODEX_HOME: dir, FAKE_MODE_FILE: join(tmp, 'fake-mode'), ...env };
  return hh;
};

const body = (input: string, withMcp = true): Record<string, unknown> => ({ input, manythreads: { tools: [], ...(withMcp ? { mcp: { url: mcp.url, token: TOKEN } } : {}) } });
async function go(hh: Harness, input: string, withMcp = true): Promise<Array<{ data: Record<string, any> }>> {
  const res = await start(hh, body(input, withMcp));
  const { run_id } = (await res.json()) as { run_id: string };
  return events(hh, run_id);
}
const last = (evs: Array<{ data: Record<string, any> }>): Record<string, any> => evs[evs.length - 1]!.data;
const text = (path: string): string => readFileSync(path, 'utf8');

describe('the stand-in claude', () => {
  it('speaks stream-json with a tool call and its result, and calls the run\'s MCP address for real', async () => {
    h = await claudeHarness(claudeFolder());
    const evs = await go(h, 'please FAKECALL messages.post {"text":"hello team"}');
    expect(evs.map((e) => e.data['event'])).toEqual(['tool.started', 'tool.completed', 'message.delta', 'run.completed']);
    expect(evs[0]!.data).toMatchObject({ tool: 'mcp__manythreads__messages_post' });
    expect(String(evs[0]!.data['preview'])).toContain('hello team');
    expect(evs[1]!.data).toMatchObject({ tool: 'mcp__manythreads__messages_post', error: false });
    expect(last(evs)).toMatchObject({ event: 'run.completed', output: 'Stand-in reply: messages.post worked.', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    // what the MCP stand-in saw: the four calls, in order, each with the run token, and the session id the server gave
    expect(mcp.calls.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(mcp.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(mcp.calls.slice(1).every((c) => c.session === 'sess-1')).toBe(true);
    expect(mcp.calls[3]!.params).toEqual({ name: 'messages.post', arguments: { text: 'hello team' } });
    // the token reaches the platform and nothing else: not an event, not the final answer
    expect(JSON.stringify(evs)).not.toContain(TOKEN);
  });

  it('an ordinary run lists the tools and calls none', async () => {
    h = await claudeHarness(claudeFolder());
    const evs = await go(h, 'just answer');
    expect(evs.map((e) => e.data['event'])).toEqual(['message.delta', 'run.completed']);
    expect(mcp.calls.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });

  it('shows a tool the platform refused as a failed tool, and still ends the run', async () => {
    h = await claudeHarness(claudeFolder());
    const evs = await go(h, 'FAKECALL broken.tool');
    expect(evs[1]!.data).toMatchObject({ event: 'tool.completed', error: true });
    expect(last(evs)).toMatchObject({ event: 'run.completed', output: 'Stand-in reply: broken.tool did not work.' });
  });

  it('a call asked for with no MCP address in the run is a failed tool, not a crash', async () => {
    h = await claudeHarness(claudeFolder());
    const evs = await go(h, 'FAKECALL messages.post', false);
    expect(evs[1]!.data).toMatchObject({ event: 'tool.completed', error: true });
    expect(mcp.calls).toEqual([]);
  });

  it('FAKE401 is a refused sign-in: the run fails as needs_sign_in and the next run starts no process', async () => {
    const dir = claudeFolder();
    h = await claudeHarness(dir, {}, { claudeConfigDir: dir });
    expect(last(await go(h, 'FAKE401 please'))).toMatchObject({ event: 'run.failed', reason: 'needs_sign_in' });
    expect(mcp.calls).toEqual([]);
    // no process: a stand-in that did start would have listed the MCP tools
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.failed', reason: 'needs_sign_in' });
    expect(mcp.calls).toEqual([]);
    // an uploaded replacement clears it
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-b', refreshToken: 'fake-r1', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] } }));
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.completed' });
  });

  it('FAKELIMIT is a plan limit with a reset time about an hour away, and the next run is refused without a process', async () => {
    const dir = claudeFolder();
    h = await claudeHarness(dir, {}, { claudeConfigDir: dir });
    const failed = last(await go(h, 'FAKELIMIT'));
    expect(failed).toMatchObject({ event: 'run.failed', reason: 'plan_limit' });
    expect(failed['resets_at']).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(failed['resets_at']).toBeLessThan(Date.now() + 70 * 60_000);
    expect(last(await go(h, 'again'))).toMatchObject({ reason: 'plan_limit' });
    expect(mcp.calls).toEqual([]);
  });

  it('a word in the mode file steers it like a word in the prompt, and removing the file puts it back', async () => {
    h = await claudeHarness(claudeFolder());
    writeFileSync(join(tmp, 'fake-mode'), 'FAKELIMIT\n');
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.failed' });
    rmSync(join(tmp, 'fake-mode'));
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.completed' });
  });

  it('no sign-in file, or a token that is not a stand-in token, is a refused sign-in', async () => {
    const empty = folder('empty');
    h = await claudeHarness(empty, {}, { claudeConfigDir: empty });
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.failed', reason: 'needs_sign_in' });
    await h.close();
    const odd = claudeFolder({ access: 'sk-ant-oat01-real-looking' });
    h = await claudeHarness(odd, {}, { claudeConfigDir: odd });
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.failed', reason: 'needs_sign_in' });
  });

  it('FAKEREFRESH renews the file: a new access token and expiry, every other byte the same, the mode kept, no temp file left', async () => {
    const dir = claudeFolder({ expiresInMs: 3600_000 });
    chmodSync(join(dir, '.credentials.json'), 0o600);
    const before = text(join(dir, '.credentials.json'));
    h = await claudeHarness(dir, {}, { claudeConfigDir: dir });
    expect(last(await go(h, 'FAKEREFRESH'))).toMatchObject({ event: 'run.completed' });
    const after = text(join(dir, '.credentials.json'));
    expect(after).not.toBe(before);
    expect(JSON.parse(after).claudeAiOauth.accessToken).toMatch(/^fake-access-[0-9a-f]{12}$/);
    expect(JSON.parse(after).claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 7 * 3600_000);
    // same bytes otherwise: put the two renewed values back and the text is the file it was
    const restored = after.replace(/("accessToken"\s*:\s*")[^"]*(")/, (_m, a, b) => `${a}fake-access-${CANARY}${b}`).replace(/("expiresAt"\s*:\s*)\d+/, (_m, a) => `${a}${JSON.parse(before).claudeAiOauth.expiresAt}`);
    expect(restored).toBe(before);
    expect(statSync(join(dir, '.credentials.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(['.credentials.json']);
  });

  it('renews a file that is close to its end on its own, and the gate then sees it as healthy', async () => {
    const dir = claudeFolder({ expiresInMs: 2 * 60_000 });
    h = await claudeHarness(dir, {}, { claudeConfigDir: dir });
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.completed' });
    expect(JSON.parse(text(join(dir, '.credentials.json'))).claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 7 * 3600_000);
    const check = (await (await fetch(`${h.bridge.url}/v1/signin/check`, { method: 'POST', headers: { authorization: 'Bearer test-bridge-key-0123456789' } })).json()) as { result: string };
    expect(check.result).toBe('ok');
  });

  it('never looks in the home folder: a sign-in file there is not used', async () => {
    const home = folder('home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-HOME-CANARY', refreshToken: 'x', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] } }));
    h = await claudeHarness(folder('empty'), { HOME: home });
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.failed' });
  });
});

describe('the stand-in codex', () => {
  it('speaks the codex --json lines with an MCP tool call and calls the run\'s MCP address for real', async () => {
    h = await codexHarness(codexFolder());
    const evs = await go(h, 'FAKECALL messages.post {"text":"hi"}');
    expect(evs.map((e) => e.data['event'])).toEqual(['tool.started', 'tool.completed', 'message.delta', 'run.completed']);
    expect(evs[0]!.data).toMatchObject({ tool: 'mcp__manythreads__messages.post' });
    expect(evs[1]!.data).toMatchObject({ tool: 'mcp__manythreads__messages.post', error: false });
    expect(last(evs)).toMatchObject({ event: 'run.completed', output: 'Stand-in reply: messages.post worked.', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    expect(mcp.calls.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(mcp.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(mcp.calls[3]!.params).toEqual({ name: 'messages.post', arguments: { text: 'hi' } });
    expect(JSON.stringify(evs)).not.toContain(TOKEN);
  });

  it('shows a tool the platform refused as a failed tool', async () => {
    h = await codexHarness(codexFolder());
    const evs = await go(h, 'FAKECALL broken.tool');
    expect(evs[1]!.data).toMatchObject({ event: 'tool.completed', error: true });
  });

  it('FAKE401 and FAKELIMIT fail the run with the texts the driver will meet', async () => {
    h = await codexHarness(codexFolder());
    expect(last(await go(h, 'FAKE401'))).toMatchObject({ event: 'run.failed' });
    expect(String(last(await go(h, 'FAKE401'))['error'])).toMatch(/401 Unauthorized/);
    expect(String(last(await go(h, 'FAKELIMIT'))['error'])).toMatch(/usage limit/);
    expect(mcp.calls).toEqual([]);
  });

  it('refuses a file that holds an API key or is not the ChatGPT sign-in', async () => {
    h = await codexHarness(codexFolder({ OPENAI_API_KEY: 'sk-made-up-key' }));
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.failed' });
    await h.close();
    h = await codexHarness(codexFolder({ auth_mode: 'apikey' }));
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.failed' });
  });

  it('FAKEREFRESH replaces the refresh token and keeps every other byte; the old token is remembered', async () => {
    const dir = codexFolder();
    const before = text(join(dir, 'auth.json'));
    h = await codexHarness(dir);
    expect(last(await go(h, 'FAKEREFRESH'))).toMatchObject({ event: 'run.completed' });
    const after = text(join(dir, 'auth.json'));
    const doc = JSON.parse(after);
    expect(doc.tokens.refresh_token).toMatch(/^fake-refresh-[0-9a-f]{12}$/);
    expect(doc.tokens.access_token).not.toBe(JSON.parse(before).tokens.access_token);
    expect(doc.tokens.id_token).toBe(JSON.parse(before).tokens.id_token);
    expect(doc.tokens.account_id).toBe('acct-canary');
    const restored = after
      .replace(/("access_token"\s*:\s*")[^"]*(")/, (_m, a, b) => `${a}fake-access-${CANARY}${b}`)
      .replace(/("refresh_token"\s*:\s*")[^"]*(")/, (_m, a, b) => `${a}fake-refresh-r0${b}`)
      .replace(/("last_refresh"\s*:\s*")[^"]*(")/, (_m, a, b) => `${a}${JSON.parse(before).last_refresh}${b}`);
    expect(restored).toBe(before);
    expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(text(join(dir, '.fake-used-refresh'))).toBe('fake-refresh-r0\n');
    expect(readdirSync(dir).sort()).toEqual(['.fake-used-refresh', 'auth.json']);
  });

  it('renews on its own when last_refresh is over eight days old', async () => {
    const dir = codexFolder({}, new Date(Date.now() - 9 * 86_400_000).toISOString());
    h = await codexHarness(dir);
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.completed' });
    expect(JSON.parse(text(join(dir, 'auth.json'))).tokens.refresh_token).not.toBe('fake-refresh-r0');
  });

  it('runs that renew one after the other all pass; two at the same moment meet refresh_token_reused (what the bridge gate is for)', async () => {
    const dir = codexFolder();
    h = await codexHarness(dir);
    for (const n of [1, 2, 3]) expect(last(await go(h, `FAKEREFRESH ${n}`))).toMatchObject({ event: 'run.completed' });

    const results = await Promise.all([go(h, 'FAKEREFRESH a'), go(h, 'FAKEREFRESH b')]);
    const ends = results.map(last);
    expect(ends.map((e) => e['event']).sort()).toEqual(['run.completed', 'run.failed']);
    expect(String(ends.find((e) => e['event'] === 'run.failed')!['error'])).toContain('refresh_token_reused');
    // the failed one left the file as the first one wrote it
    expect(JSON.parse(text(join(dir, 'auth.json'))).tokens.refresh_token).toMatch(/^fake-refresh-[0-9a-f]{12}$/);
  });

  it('never looks in the home folder: an auth.json there is not used', async () => {
    const home = folder('home');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'fake-HOME-CANARY', refresh_token: 'x' }, last_refresh: new Date().toISOString() }));
    h = await codexHarness(folder('empty'), { HOME: home });
    expect(last(await go(h, 'hello'))).toMatchObject({ event: 'run.failed' });
  });
});

describe('what the stand-ins may touch', () => {
  it('their sources never name the home folder or a real sign-in path', () => {
    for (const file of [STAND_IN_CLAUDE, STAND_IN_CODEX]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/homedir|process\.env\.HOME\b|process\.env\['HOME'\]|~\/|\/root\/|\/home\//);
      // the only places they open are their own config folder, the mode file and the MCP config the bridge gave them
      expect(source, file).not.toMatch(/['"`]\.claude['"`]|['"`]\.codex['"`]|\/\.claude|\/\.codex/);
    }
  });

  it('this test reads no path under the real home folder', () => {
    const me = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(me).not.toMatch(/process\.env\.HOME|\bhomedir\(|~\/\.(claude|codex)/);
  });
});
