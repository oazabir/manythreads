#!/usr/bin/env node
// STAND-IN for the `claude` command (claude-pod-fake image). It prints the stream-json lines the bridge reads, and acts on the sign-in file the way the real one is
// believed to: it needs $CLAUDE_CONFIG_DIR/.credentials.json with an access token that starts "fake-". Words in the prompt steer it:
//   FAKE401 -> answers as if the sign-in was refused      FAKELIMIT -> answers as if the plan's limit was reached
// It never contacts anything and never prints the sign-in file. Wording of the failures is a guess until the real command is measured (P19-01).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sid = flag('--session-id') ?? flag('--resume') ?? 'stand-in-session';
out({ type: 'system', subtype: 'init', session_id: sid, tools: [] });

let token = '';
try {
  token = String(JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? '/state/claude', '.credentials.json'), 'utf8'))?.claudeAiOauth?.accessToken ?? '');
} catch { /* no usable file */ }

const fail = (text) => { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text, session_id: sid }); process.exit(1); };
if (!token.startsWith('fake-') || stdin.includes('FAKE401')) fail('Invalid authentication credentials (stand-in)');
if (stdin.includes('FAKELIMIT')) fail('Claude usage limit reached (stand-in). Your limit will reset later.');

out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Stand-in reply: the runner and its sign-in file work.' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Stand-in reply: the runner and its sign-in file work.', session_id: sid, usage: { input_tokens: 1, output_tokens: 1 } });
