// The Hermes stand-in of Lena's journeys (PLAN P12-03): the part of the model for the two bots whose work she reads, Coder's release post and Brain's shared answer. There is
// no model behind it; the platform runs for real (the run, the tools, the source check, the Answer card) and only the words are written in advance.
//
//   ANSWER-WITH-SOURCES <id> <id> SEARCH <query>; <query>   Brain: look the questions up (so the run has read what it cites), then finish with an Answer that cites each id
//   a mention that asks for a "release post"               Coder: the post, as the reply of the run
//   anything else                                          echo
import { readFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8').trim();

const call = async (name, args) => {
  const config = readFileSync(`${process.env.HERMES_HOME ?? ''}/config.yaml`, 'utf8');
  const url = JSON.parse(/^\s+url: (.*)$/m.exec(config)[1]);
  const bearer = JSON.parse(/Authorization: (.*)$/m.exec(config)[1]);
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.status;
};

const out = (type, body) => process.stdout.write(`${JSON.stringify({ type, ...body })}\n`);
let reply = `Answering: ${prompt.replace(/\s+/g, ' ')}`;

if (prompt.includes('ANSWER-WITH-SOURCES')) {
  const ids = prompt.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
  const queries = (/SEARCH (.*)$/s.exec(prompt)?.[1] ?? '').split(';').map((q) => q.trim()).filter(Boolean);
  for (const query of queries) await call('messages.search', { query });
  await call('answer.post', {
    body: 'A release goes out with a canary at 10% for 30 minutes before it is promoted [1]. If errors stay above 1% the rollback is one command, and the lead who owns the release decides [2].',
    citations: ids.map((id, i) => ({ kind: 'message', messageId: id, snippet: i === 0 ? 'Rollback test passed on staging: deploy rollback took 2 minutes' : 'a line from a private room that must never be shown' })),
    chips: [{ kind: 'followup', prompt: 'Who decides a rollback?', label: 'Who decides a rollback?' }],
  });
  reply = 'Posted my answer above.';
} else if (/release post/i.test(prompt)) {
  reply = '**v2.14.0** is out. The search cache now lives 60 seconds instead of 300. The release went out with a canary at 10% for 30 minutes, then to everyone. Rollback, if needed: `deploy rollback v2.13.2`.';
}
out('text', { text: 'Answering: ' });
out('result', { exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } });
