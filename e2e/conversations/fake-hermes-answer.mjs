// The stand-in for `hermes chat --oneshot --format stream-json` of the Answer specs (PLAN P5-18). Like fake-hermes.mjs it reads the prompt on
// stdin and answers with JSON lines, but when the prompt asks for an answer it behaves like a model that finishes with the `answer.post` tool: it
// reads the run's own MCP endpoint and bearer token from the profile the platform rendered (`$HERMES_HOME/config.yaml`), cites the ids it finds
// in the prompt, and calls the tool over HTTP. There is no model behind it; what the platform does with the call is the thing under test.
//
//   ANSWER-WITH-SOURCES <id> <id> ...   search the team's messages for the public question (so the run reaches it, as a model that reads before
//                                       it cites would), then cite each id as a message, in order; suggest a follow-up and a hand-off to `coder`.
//                                       An id the search did not reach is not discussed by the platform: it is only counted.
//   ANSWER-TWICE                        call the tool twice (the second call must be refused)
//   REHEARSE-WRITE <channelId>          (the Test action, P7-11) try to post a message into that channel and to write a page, then finish with a
//                                       plain Answer: in a rehearsal the gateway holds both writes back, in a normal run they happen
//   anything else                       echo, as fake-hermes.mjs does
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

const ids = prompt.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
if (prompt.includes('ANSWER-WITH-SOURCES')) {
  await call('messages.search', { query: 'Monday change window' });
  await call('answer.post', {
    body: `The deploy is waiting for the Monday window [1]. There is one more source behind this answer [2], which I may not repeat.`,
    citations: ids.map((id, i) => ({ kind: 'message', messageId: id, snippet: i === 0 ? 'The deploy waits for the Monday change window' : 'a quote that must never be shown' })),
    chips: [{ kind: 'followup', prompt: 'When does the window open?', label: 'When does it open?' }, { kind: 'handoff', botSlug: 'coder' }],
  });
} else if (prompt.includes('REHEARSE-WRITE')) {
  const channelId = /REHEARSE-WRITE ([0-9a-f-]{36})/.exec(prompt)?.[1];
  await call('messages.post', { channelId, body: 'Written by the rehearsal bot: never visible' });
  await call('pages.write', { mode: 'create', path: 'pages/rehearsal-probe.md', content: 'never written' });
  await call('answer.post', { body: 'I would post that message and write that page, but nothing was done.' });
} else if (prompt.includes('ANSWER-TWICE')) {
  await call('answer.post', { body: 'The one and only answer.' });
  await call('answer.post', { body: 'A second answer, which must not appear.' });
}

const reply = prompt.includes('ANSWER-') || prompt.includes('REHEARSE-WRITE') ? 'Posted my answer above.' : `Answering: ${prompt.replace(/\s+/g, ' ')}`;
process.stdout.write(`${JSON.stringify({ type: 'text', text: 'Answering: ' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } })}\n`);
