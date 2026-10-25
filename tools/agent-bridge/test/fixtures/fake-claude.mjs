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
  process.stderr.write(`No conversation found with session ID: ${sid}\n`);
  process.exit(1);
}
if (flag('--session-id')) writeFileSync(marker, '1');

out({ type: 'system', subtype: 'init', session_id: sid, tools: [] });

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
  out({ type: 'result', subtype: 'success', is_error: false, result: stdin.includes('ECHOTOKEN') ? `Done. token=${process.env.MANYTHREADS_RUN_TOKEN}` : 'Looking. Done.', session_id: sid, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } });
}
