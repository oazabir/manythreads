#!/usr/bin/env node
// A stand-in for `claude` that prints realistic stream-json and records how it was called. It is steered by words in the prompt.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const dir = process.env.FAKE_CLI_DIR;
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;

const mcpPath = flag('--mcp-config');
const instrPath = flag('--append-system-prompt-file');
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({
  argv, stdin, cwd: process.cwd(),
  token: process.env.MANYTHREADS_RUN_TOKEN ?? null,
  envKeys: Object.keys(process.env), githubToken: process.env.GITHUB_TOKEN ?? null, kube: process.env.KUBECONFIG ?? null, passed: process.env.PASSED_VAR ?? null,
  hasBridgeKey: 'AGENT_BRIDGE_API_KEY' in process.env,
  mcp: mcpPath && existsSync(mcpPath) ? readFileSync(mcpPath, 'utf8') : null,
  mcpMode: mcpPath && existsSync(mcpPath) ? (await import('node:fs')).statSync(mcpPath).mode & 0o777 : null,
  instructions: instrPath && existsSync(instrPath) ? readFileSync(instrPath, 'utf8') : null,
}) + '\n');

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sid = flag('--session-id') ?? flag('--resume') ?? 'no-session';
const marker = join(dir, `session-${sid}`);

if (argv.includes('--resume') && !existsSync(marker)) {
  // The real shape (Claude Code 2.1.319, measured): the words are on stderr AND in the `errors` list of a failed result that has no `result` text; exit code 1.
  process.stderr.write(`No conversation found with session ID: ${sid}\n`);
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: sid, errors: [`No conversation found with session ID: ${sid}`] });
  process.exit(1);
}
if (flag('--session-id')) writeFileSync(marker, '1');

out({ type: 'system', subtype: 'init', session_id: sid, tools: [] });

// Sign-in behaviour of the stand-in (P19-06). Words in the prompt: FAKE401 answers a refused sign-in, FAKELIMIT the plan limit. Always: if the sign-in file in CLAUDE_CONFIG_DIR is
// close to its expiry, it is renewed like the real CLI does it: a new refresh token is written and the old one is remembered; presenting a remembered one is a 401.
const cfg = process.env.CLAUDE_CONFIG_DIR;
if (cfg && existsSync(join(cfg, '.credentials.json'))) {
  const file = join(cfg, '.credentials.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const oauth = doc.claudeAiOauth ?? {};
  const usedPath = join(cfg, '.used-refresh');
  if (oauth.expiresAt - Date.now() < 20 * 60_000) {
    await new Promise((r) => setTimeout(r, 500)); // a refresh takes a moment (long enough that a second run started under load still meets the first one)
    const used = existsSync(usedPath) ? readFileSync(usedPath, 'utf8').split('\n') : [];
    if (used.includes(oauth.refreshToken)) {
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 401 refresh token already used', session_id: sid });
      process.exit(0);
    }
    appendFileSync(usedPath, oauth.refreshToken + '\n');
    oauth.refreshToken = 'fake-refresh-' + Math.random().toString(36).slice(2);
    oauth.accessToken = 'fake-access-' + Math.random().toString(36).slice(2);
    oauth.expiresAt = Date.now() + 8 * 3600_000;
    writeFileSync(file, JSON.stringify({ ...doc, claudeAiOauth: oauth }));
  }
}
if (stdin.includes('FAKE401')) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 401 FAKE401', session_id: sid });
  process.exit(0);
}
if (stdin.includes('NOTLOGGEDIN')) {
  // The real shape of a refused request (Claude Code 2.1.319, measured with no login): a synthetic assistant message with an `error` field, then a result whose subtype is still "success".
  out({ type: 'assistant', error: 'authentication_failed', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Not logged in \u00b7 Please run /login' }] }, session_id: sid });
  out({ type: 'result', subtype: 'success', is_error: true, api_error_status: null, terminal_reason: 'api_error', result: 'Not logged in \u00b7 Please run /login', session_id: sid });
  process.exit(1);
}
if (stdin.includes('FAKELIMIT')) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached|1900000000 FAKELIMIT', session_id: sid });
  process.exit(0);
}

if (stdin.includes('CRASH')) {
  process.stderr.write(`boom with token ${process.env.MANYTHREADS_RUN_TOKEN}\n`);
  process.exit(2);
}
if (stdin.includes('BGPROC')) {
  const bg = spawn('sleep', ['120'], { stdio: 'ignore' }); // a background process a tool left behind, same group
  bg.unref();
  writeFileSync(join(dir, 'bg.pid'), String(bg.pid));
}
if (stdin.includes('SLOW') || stdin.includes('TRAP')) {
  const kid = spawn('sleep', ['120'], { stdio: 'ignore' }); // same process group: a stop must reach it
  writeFileSync(join(dir, 'child.pid'), String(kid.pid));
  writeFileSync(join(dir, 'self.pid'), String(process.pid));
  if (stdin.includes('TRAP')) process.on('SIGTERM', () => {});
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
  setInterval(() => {}, 1000);
} else if (stdin.includes('ERRORRESULT')) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Credit balance is too low', session_id: sid });
} else {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking. ' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello', is_error: false }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__manythreads__post', input: { text: 'x' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'denied', is_error: true }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: stdin.includes('ECHOTOKEN') ? `Done. token=${process.env.MANYTHREADS_RUN_TOKEN}` : 'Looking. Done.', session_id: sid, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, total_cost_usd: 0.0123 });
}
