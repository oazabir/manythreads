// The stand-in for `hermes chat --oneshot --format stream-json` of the routine specs (PLAN P20-T3). Like fake-hermes-personal.mjs it reads the prompt on stdin, takes
// the run's own MCP endpoint and bearer token from the profile the platform rendered (`$HERMES_HOME/config.yaml`) and calls tools over HTTP, then finishes with a
// plain reply. A person's routine saves that reply as its output file, so a spec reads what the run did from the file. There is no model behind it; what the gateway
// lets through for a routine (the owner's own reads, a write held for the owner, the budget of tool calls) is the thing under test.
//
// The routine's prompt carries the directive (the person writes the prompt, so a spec can put a directive in it). A TAG-<word> anywhere is repeated at the head of the reply.
//
//   ROUTINE-READ <path>                 files.read of that path of the asking person's Personal files
//   ROUTINE-SEARCH <words>              messages.search for the words
//   ROUTINE-POST <channelId> <text>     messages.post into that channel (a routine's write waits for its owner)
//   ROUTINE-TOOLS <n>                   n calls of messages.search, one after the other; the reply is the answer to the last one
//   ROUTINE-FAIL                        no output at all (an empty reply)
//   anything else                       "Routine note: ..." (the first words of the prompt)
import { readFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8').trim();

/** Calls a tool of the run's endpoint and answers the text the tool returned (the JSON the gateway wraps in `content[0].text`). */
const call = async (name, args) => {
  const config = readFileSync(`${process.env.HERMES_HOME ?? ''}/config.yaml`, 'utf8');
  const url = JSON.parse(/^\s+url: (.*)$/m.exec(config)[1]);
  const bearer = JSON.parse(/Authorization: (.*)$/m.exec(config)[1]);
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: bearer, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const json = raw.trimStart().startsWith('{') ? raw : (raw.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
  try {
    const body = JSON.parse(json);
    return body?.result?.content?.[0]?.text ?? JSON.stringify(body?.error ?? body);
  } catch {
    return `HTTP ${res.status} ${raw.slice(0, 200)}`;
  }
};

const tag = /TAG-\w+/.exec(prompt)?.[0] ?? 'TAG-none';
const flat = (s) => s.replace(/\s+/g, ' ').slice(0, 4000);
const read = /ROUTINE-READ (\S+)/.exec(prompt);
const search = /ROUTINE-SEARCH ([^\n]+?)(?: TAG-\w+)?(?:\n|$)/.exec(prompt);
const post = /ROUTINE-POST ([0-9a-f-]{36}) ([^\n]+?)(?: TAG-\w+)?(?:\n|$)/.exec(prompt);
const tools = /ROUTINE-TOOLS (\d+)/.exec(prompt);

let reply = `Routine note: ${prompt.replace(/\s+/g, ' ').slice(0, 120)}`;
if (prompt.includes('ROUTINE-FAIL')) reply = '';
else if (read) reply = `ROUTINE-OUT ${tag} ${flat(await call('files.read', { path: read[1] }))}`;
else if (search) reply = `ROUTINE-OUT ${tag} ${flat(await call('messages.search', { query: search[1].trim().slice(0, 200) }))}`;
else if (post) reply = `ROUTINE-OUT ${tag} ${flat(await call('messages.post', { channelId: post[1], body: post[2].trim().slice(0, 500) }))}`;
else if (tools) {
  let last = '';
  for (let i = 0; i < Math.min(Number(tools[1]), 60); i += 1) last = await call('messages.search', { query: `routine budget ${String(i)}` });
  reply = `ROUTINE-OUT ${tag} ${flat(last)}`;
}

process.stdout.write(`${JSON.stringify({ type: 'text', text: 'Working: ' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } })}\n`);
