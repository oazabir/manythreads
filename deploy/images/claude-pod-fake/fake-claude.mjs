#!/usr/bin/env node
// STAND-IN for the `claude` command (claude-pod-fake image; PLAN P19-11). It speaks the `--output-format stream-json` lines the bridge reads (system/init, assistant text, a
// tool_use and its tool_result, result), and it calls the run's MCP address FOR REAL: `initialize`, `tools/list` and, when the prompt asks, one `tools/call`.
//
// What it reads: $CLAUDE_CONFIG_DIR/.credentials.json (an access token that starts "fake-"), the `--mcp-config` file the bridge wrote (the bearer token is expanded from
// $MANYTHREADS_RUN_TOKEN, like the real command does it), and the prompt on stdin. Words steer it, in the prompt or in the file $FAKE_MODE_FILE (default /state/fake-mode):
//   FAKE401               answers as if the sign-in was refused
//   FAKELIMIT             answers as if the plan's limit was reached (with a reset time an hour away)
//   FAKEREFRESH           renews the sign-in file first: a new access token and expiry, every other byte unchanged, written to a temp file and renamed over the old one
//   FAKECALL <tool> [{json arguments}]
//                         one MCP `tools/call` of that tool, shown as a tool_use and a tool_result (for example `FAKECALL messages.post {"text":"hi"}`)
// It also renews the file when the access token has under five minutes left, as the real command does. It never prints a token or the sign-in file, and it never reads
// anything outside the two folders above: not the operator's own Claude folder. The wording of the failures is a guess until the real command is measured (P19-01).
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sid = flag('--session-id') ?? flag('--resume') ?? 'stand-in-session';
const configDir = process.env.CLAUDE_CONFIG_DIR ?? '/state/claude';
const credPath = join(configDir, '.credentials.json');

let modeFile = '';
try { modeFile = readFileSync(process.env.FAKE_MODE_FILE ?? '/state/fake-mode', 'utf8'); } catch { /* no mode file: the prompt decides */ }
const words = `${stdin}\n${modeFile}`;

// ---- the sign-in file -------------------------------------------------------------------------------------------------------------------------------------------
let raw = '';
let oauth = null;
try {
  raw = readFileSync(credPath, 'utf8');
  oauth = JSON.parse(raw)?.claudeAiOauth ?? null;
} catch { /* no usable file */ }
const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken : '';

const fail = (text) => {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text, session_id: sid });
  process.exit(1);
};
const early = () => out({ type: 'system', subtype: 'init', session_id: sid, tools: [], mcp_servers: [] });
if (!token.startsWith('fake-') || words.includes('FAKE401')) { early(); fail('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials (stand-in)"}}'); }
if (words.includes('FAKELIMIT')) { early(); fail(`Claude usage limit reached (stand-in). Your limit will reset later.|${Math.floor(Date.now() / 1000) + 3600}`); }

// Renew like the real command: a new access token and expiry; the file is replaced whole (temp file, then rename) and keeps its mode.
const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : Infinity;
if (words.includes('FAKEREFRESH') || expiresAt - Date.now() < 5 * 60_000) {
  const fresh = `fake-access-${randomBytes(6).toString('hex')}`;
  const next = raw
    .replace(/("accessToken"\s*:\s*")[^"]*(")/, (_m, a, b) => `${a}${fresh}${b}`)
    .replace(/("expiresAt"\s*:\s*)\d+/, (_m, a) => `${a}${Date.now() + 8 * 3600_000}`);
  const tmp = join(dirname(credPath), `.credentials.json.tmp-${process.pid}`);
  let mode = 0o600;
  try { mode = statSync(credPath).mode & 0o777; } catch { /* keep 0600 */ }
  writeFileSync(tmp, next, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, credPath);
}

// ---- the run's MCP address ----------------------------------------------------------------------------------------------------------------------------------
const expand = (s) => String(s).replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? '');
let mcp = null;
try {
  const file = flag('--mcp-config');
  const servers = file ? Object.entries(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {}) : [];
  const [name, server] = servers[0] ?? [];
  if (server?.url) mcp = { name, url: server.url, auth: expand(server.headers?.Authorization ?? ''), session: null, id: 0 };
} catch { /* no MCP config */ }

async function rpc(method, params, notify = false) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (mcp.auth) headers.authorization = mcp.auth;
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

let listed = [];
let connected = false;
if (mcp) {
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code-stand-in', version: '0.0.0' } });
    await rpc('notifications/initialized', {}, true);
    listed = (await rpc('tools/list', {}))?.tools ?? [];
    connected = true;
  } catch { /* an ordinary run does not need the platform's tools; a FAKECALL run says so below */ }
}
const safe = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_');
out({ type: 'system', subtype: 'init', session_id: sid, tools: listed.map((t) => `mcp__${mcp.name}__${safe(t.name)}`), mcp_servers: mcp ? [{ name: mcp.name, status: connected ? 'connected' : 'failed' }] : [] });

// ---- one tool call, when asked --------------------------------------------------------------------------------------------------------------------------------
let said = 'Stand-in reply: the runner and its sign-in file work.';
const ask = /FAKECALL\s+([A-Za-z0-9_.-]+)(?:[ \t]+(\{[^\n]*\}))?/.exec(stdin);
if (ask) {
  const tool = ask[1];
  let args = {};
  try { args = ask[2] ? JSON.parse(ask[2]) : {}; } catch { /* arguments that are not JSON go as none */ }
  const shown = `mcp__${mcp?.name ?? 'manythreads'}__${safe(tool)}`;
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_stand_in_1', name: shown, input: args }] } });
  let text = 'no MCP server is configured for this run (stand-in)';
  let isError = true;
  if (connected) {
    try {
      const result = await rpc('tools/call', { name: tool, arguments: args });
      text = JSON.stringify(result?.content ?? result ?? {}).slice(0, 2000);
      isError = result?.isError === true;
    } catch (err) {
      text = String(err instanceof Error ? err.message : err).slice(0, 300);
    }
  }
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_stand_in_1', content: text, is_error: isError }] } });
  said = isError ? `Stand-in reply: ${tool} did not work.` : `Stand-in reply: ${tool} worked.`;
}

out({ type: 'assistant', message: { content: [{ type: 'text', text: said }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: said, session_id: sid, usage: { input_tokens: 1, output_tokens: 1 } });
