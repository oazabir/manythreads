// The stand-in for `hermes chat --oneshot --format stream-json` of the Personal-reads spec (PLAN P20-T2). Like fake-hermes-answer.mjs it reads the prompt on
// stdin, takes the run's own MCP endpoint and bearer token from the profile the platform rendered (`$HERMES_HOME/config.yaml`) and calls a tool over HTTP. It
// then finishes with a plain reply that carries what the tool answered, so a spec can read it from the thread. There is no model behind it; what the gateway
// lets through (Personal files and knowledge in the owner's own chat, nothing in a team channel) is the thing under test.
//
//   PERSONAL-FILE <path>      (with a TAG-<word> anywhere) files.read of that path of the asking person's Personal files
//   PERSONAL-SEARCH <words>   knowledge.search for the words
//   anything else             echo
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

let reply = `Answering: ${prompt.replace(/\s+/g, ' ')}`;
// a TAG-<word> in the prompt is repeated at the head of the reply, so a spec can tell which ask a reply answers
const tag = /TAG-\w+/.exec(prompt)?.[0] ?? 'TAG-none';
const bare = prompt.replace(/TAG-\w+/g, '').trim();
const file = /PERSONAL-FILE (\S+)/.exec(bare);
const search = /PERSONAL-SEARCH (.+)/.exec(bare);
if (file) reply = `RESULT-FILE ${tag} ${(await call('files.read', { path: file[1] })).replace(/\s+/g, ' ').slice(0, 1500)}`;
else if (search) reply = `RESULT-SEARCH ${tag} ${(await call('knowledge.search', { query: search[1].trim().slice(0, 200) })).replace(/\s+/g, ' ').slice(0, 1500)}`;

process.stdout.write(`${JSON.stringify({ type: 'text', text: 'Answering: ' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } })}\n`);
