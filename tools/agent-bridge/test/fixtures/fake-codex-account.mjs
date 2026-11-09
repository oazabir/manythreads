#!/usr/bin/env node
// A stand-in for `codex` that only fails, for the tests of account failures: it records the call (like fake-codex.mjs) and then fails the turn with the text that follows
// "FAIL:" on the first line of the prompt. It never reads or prints a sign-in file.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_CLI_DIR;
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ argv: process.argv.slice(2), stdin, envKeys: Object.keys(process.env) }) + '\n');
const text = /FAIL:(.*)/.exec(stdin)?.[1]?.trim() || 'the turn failed';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'thread.started', thread_id: 'thread-fail' });
out({ type: 'turn.started' });
out({ type: 'error', message: text });
out({ type: 'turn.failed', error: { message: text } });
process.exit(1);
