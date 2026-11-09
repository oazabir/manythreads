#!/usr/bin/env node
// STAND-IN for the `codex` command (claude-pod-fake image; PLAN P19-11 and P19-13). It speaks the `codex exec --json` lines the bridge's Codex driver reads
// (thread.started, turn.started, item.started and item.completed for an MCP tool call and for the answer, turn.completed; error and turn.failed on a failure) and it calls
// the run's MCP address FOR REAL: `initialize`, `tools/list` and, when the prompt asks, one `tools/call`. The address and the tool come from the same `-c` options the driver
// passes (`mcp_servers.<name>.url`, `bearer_token_env_var`); the bearer token is read from that environment variable.
//
// It reads $CODEX_HOME/auth.json (default /state/codex): `auth_mode` "chatgpt", no OPENAI_API_KEY value, and an access token that starts "fake-". Words steer it, in the prompt or in
// the file $FAKE_MODE_FILE (default /state/fake-mode):
//   FAKE401               answers as if the sign-in was refused
//   FAKELIMIT             answers as if the plan's limit was reached
//   FAKEREFRESH           renews the sign-in first (also when `last_refresh` is more than eight days old, as the real command does)
//   FAKECALL <tool> [{json arguments}]    one MCP `tools/call`
// A renewal REPLACES THE REFRESH TOKEN and the file is replaced whole (temp file, then rename), every other byte unchanged. The old refresh token is remembered in
// $CODEX_HOME/.fake-used-refresh; a process that presents a remembered one fails with `refresh_token_reused` and the file is left alone, which is what two processes renewing the same
// file at once meet. It never prints a token or the sign-in file, and never reads anything outside $CODEX_HOME: not the operator's own Codex folder.
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const home = process.env.CODEX_HOME ?? '/state/codex';
const authPath = join(home, 'auth.json');
const usedPath = join(home, '.fake-used-refresh');

// `-c key=value` pairs (a TOML basic string is close enough to a JSON string for what the driver sends)
const config = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '-c' || i + 1 >= argv.length) continue;
  const eq = argv[i + 1].indexOf('=');
  if (eq === -1) continue;
  const key = argv[i + 1].slice(0, eq);
  const val = argv[i + 1].slice(eq + 1);
  try { config[key] = JSON.parse(val); } catch { config[key] = val.replace(/^"|"$/g, ''); }
}
// `codex exec resume … <thread id> -`: the thread id is the argument before the final `-`
const threadId = argv[1] === 'resume' && argv.length >= 3 ? argv[argv.length - 2] : randomUUID();

let modeFile = '';
try { modeFile = readFileSync(process.env.FAKE_MODE_FILE ?? '/state/fake-mode', 'utf8'); } catch { /* no mode file: the prompt decides */ }
const words = `${stdin}\n${modeFile}`;

out({ type: 'thread.started', thread_id: threadId });
out({ type: 'turn.started' });
const fail = (text) => {
  out({ type: 'error', message: text });
  out({ type: 'turn.failed', error: { message: text } });
  process.exit(1);
};

// ---- the sign-in file -------------------------------------------------------------------------------------------------------------------------------------------
let raw = '';
let doc = null;
try {
  raw = readFileSync(authPath, 'utf8');
  doc = JSON.parse(raw);
} catch { /* no usable file */ }
const tokens = doc?.tokens ?? {};
const usable = doc?.auth_mode === 'chatgpt' && !doc?.OPENAI_API_KEY && typeof tokens.access_token === 'string' && tokens.access_token.startsWith('fake-');
if (!usable || words.includes('FAKE401')) fail('unexpected status 401 Unauthorized: Missing bearer or basic authentication in header (stand-in)');
if (words.includes('FAKELIMIT')) fail("You've hit your usage limit. Try again later (stand-in).");

const lastRefresh = Date.parse(String(doc.last_refresh ?? ''));
if (words.includes('FAKEREFRESH') || (Number.isFinite(lastRefresh) && Date.now() - lastRefresh > 8 * 86_400_000)) {
  await new Promise((r) => setTimeout(r, 500)); // a renewal takes a moment, long enough for a second process started at the same time to meet the first
  const used = existsSync(usedPath) ? readFileSync(usedPath, 'utf8').split('\n') : [];
  const presented = String(tokens.refresh_token ?? '');
  if (presented === '' || used.includes(presented)) {
    fail('Your access token could not be refreshed because your refresh token was already used (refresh_token_reused). Please log out and sign in again.');
  }
  appendFileSync(usedPath, `${presented}\n`, { mode: 0o600 });
  const next = raw
    .replace(/("access_token"\s*:\s*")[^"]*(")/, (_m, a, b) => `${a}fake-access-${randomBytes(6).toString('hex')}${b}`)
    .replace(/("refresh_token"\s*:\s*")[^"]*(")/, (_m, a, b) => `${a}fake-refresh-${randomBytes(6).toString('hex')}${b}`)
    .replace(/("last_refresh"\s*:\s*")[^"]*(")/, (_m, a, b) => `${a}${new Date().toISOString()}${b}`);
  const tmp = join(dirname(authPath), `auth.json.tmp-${process.pid}`);
  let mode = 0o600;
  try { mode = statSync(authPath).mode & 0o777; } catch { /* keep 0600 */ }
  writeFileSync(tmp, next, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, authPath);
}

// ---- the run's MCP address ----------------------------------------------------------------------------------------------------------------------------------
const name = Object.keys(config).map((k) => /^mcp_servers\.([^.]+)\.url$/.exec(k)?.[1]).find(Boolean);
const mcp = name ? { name, url: String(config[`mcp_servers.${name}.url`]), auth: process.env[String(config[`mcp_servers.${name}.bearer_token_env_var`] ?? '')] ?? '', session: null, id: 0 } : null;

async function rpc(method, params, notify = false) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (mcp.auth) headers.authorization = `Bearer ${mcp.auth}`;
  if (mcp.session) headers['mcp-session-id'] = mcp.session;
  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++mcp.id, method, params };
  const res = await fetch(mcp.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  mcp.session ??= res.headers.get('mcp-session-id');
  const text = await res.text();
  if (notify) return null;
  const data = (res.headers.get('content-type') ?? '').includes('text/event-stream') ? (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5) : text;
  const parsed = JSON.parse(data);
  if (parsed.error) throw new Error(`${method}: ${parsed.error.message ?? 'error'}`);
  return parsed.result;
}

let connected = false;
if (mcp) {
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-stand-in', version: '0.0.0' } });
    await rpc('notifications/initialized', {}, true);
    await rpc('tools/list', {});
    connected = true;
  } catch { /* an ordinary run does not need the platform's tools; a FAKECALL run says so below */ }
}

// ---- one tool call, when asked --------------------------------------------------------------------------------------------------------------------------------
let said = 'Stand-in reply: the runner and its sign-in file work.';
const ask = /FAKECALL\s+([A-Za-z0-9_.-]+)(?:[ \t]+(\{[^\n]*\}))?/.exec(stdin);
if (ask) {
  const tool = ask[1];
  let args = {};
  try { args = ask[2] ? JSON.parse(ask[2]) : {}; } catch { /* arguments that are not JSON go as none */ }
  const item = { id: 'item_1', type: 'mcp_tool_call', server: mcp?.name ?? 'manythreads', tool, arguments: args };
  out({ type: 'item.started', item: { ...item, status: 'in_progress' } });
  let isError = true;
  if (connected) {
    try {
      const result = await rpc('tools/call', { name: tool, arguments: args });
      isError = result?.isError === true;
    } catch { /* stays an error */ }
  }
  out({ type: 'item.completed', item: { ...item, status: isError ? 'failed' : 'completed' } });
  said = isError ? `Stand-in reply: ${tool} did not work.` : `Stand-in reply: ${tool} worked.`;
}

out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: said } });
out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
