#!/usr/bin/env node
// A stand-in for `codex` that prints the documented `exec --json` lines and records how it was called.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_CLI_DIR;
const argv = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ argv, stdin, cwd: process.cwd(), token: process.env.MANYTHREADS_RUN_TOKEN ?? null, envKeys: Object.keys(process.env), githubToken: process.env.GITHUB_TOKEN ?? null, hasBridgeKey: 'AGENT_BRIDGE_API_KEY' in process.env }) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const resume = argv[1] === 'resume';
if (resume && argv.includes('gone-thread')) { process.stderr.write('no rollout found for thread id gone-thread\n'); process.exit(1); }
out({ type: 'thread.started', thread_id: resume ? argv[argv.length - 2] : 'thread-abc' });
out({ type: 'turn.started' });
out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'completed', exit_code: 0 } });
out({ type: 'item.started', item: { id: 'i2', type: 'mcp_tool_call', server: 'manythreads', tool: 'post', status: 'in_progress' } });
out({ type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server: 'manythreads', tool: 'post', status: 'failed', error: { message: 'no' } } });
out({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: stdin.includes('ECHOTOKEN') ? `All done. token=${process.env.MANYTHREADS_RUN_TOKEN}` : 'All done.' } });
out({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 7 } });
