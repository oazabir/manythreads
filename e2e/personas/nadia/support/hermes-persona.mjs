// The Hermes stand-in of the Nadia and Sameera journeys (PLAN P12-03; Bundle E decision E31): there is no model behind it. Like e2e/conversations/fake-hermes-answer.mjs
// it reads the prompt on stdin and answers with JSON lines; when the question is one it knows it behaves like a model that reads before it cites and finishes with
// the `answer.post` tool, calling the run's own MCP door (so the platform re-reads every source as the asker, and a source she may not read is never shown).
//
//   "cache TTL"     searches the team's messages and memory, cites what it found, hands the answer to Coder
//   "refund"        the same for Customer support's refund policy
//   "draft" in #support  a message of its own that a person must approve (messages.post held by the bot's approval rule)
//   "Engineering"   an answer that has nothing to cite and lists what it could not reach (Sameera asks about Engineering)
//   "orchestrate"   the Bot Board of the channel (boards.ensure) and one card per step (tasks.create)
//   anything else   echo: "Answering: <prompt>" (a mention of Coder, a card, a request in a project channel)
import { readFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8').trim();

const mcp = () => {
  const config = readFileSync(`${process.env.HERMES_HOME ?? ''}/config.yaml`, 'utf8');
  return { url: JSON.parse(/^\s+url: (.*)$/m.exec(config)[1]), bearer: JSON.parse(/Authorization: (.*)$/m.exec(config)[1]) };
};
const call = async (name, args) => {
  const { url, bearer } = mcp();
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = await res.json().catch(() => ({}));
  const text = json?.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
// the messages a person may be shown as a source: those of a channel (a search also finds the question just asked in the Brain chat, which is nobody's source)
const channelHits = (found) => (Array.isArray(found?.hits) ? found.hits : []).filter((h) => h?.channel?.kind === 'channel' && typeof h.id === 'string').map((h) => ({ id: h.id, snippet: String(h.snippet ?? '').replace(/<[^>]+>/g, '').slice(0, 120) }));

// the person's own words come after the one line of context the platform writes ("Name in #channel:" / blank line)
const cut = prompt.indexOf(':\n\n');
const channel = /^[^\n]* in #([a-z0-9._-]+):/.exec(prompt)?.[1] ?? '';
const question = (cut === -1 ? prompt : prompt.slice(cut + 3)).replace(/\s+/g, ' ');

let reply = `Answering: ${prompt.replace(/\s+/g, ' ')}`;
if (/Handed over from/i.test(prompt)) {
  // a bot that is given an answer (the Coder chip of an Answer card): it says it has it, and does not answer the question again
  reply = 'Got it. I have the answer about the cache TTL and will start from its sources.';
} else if (/cache ttl/i.test(question)) {
  const found = await call('messages.search', { query: 'cache TTL' });
  const hits = channelHits(found);
  const recalled = await call('memory.recall', { query: 'cache TTL' });
  const concept = /"(?:conceptPath|path)":"([^"]+)"/.exec(JSON.stringify(recalled))?.[1];
  const citations = [
    ...hits.slice(0, 2).map((h) => ({ kind: 'message', messageId: h.id, snippet: h.snippet })),
    ...(concept ? [{ kind: 'memory', conceptPath: concept, snippet: 'The cache TTL change from 300 s to 60 s was agreed' }] : []),
  ];
  await call('answer.post', {
    body: 'The team agreed to lower the search cache TTL from 300 s to 60 s in v2.14 [1]. It is a config flag and one constant, no migration [2]. The rollback is deploy rollback v2.13 if errors stay above 1% for 5 minutes.',
    citations,
    chips: [{ kind: 'followup', prompt: 'Who is watching the canary?', label: 'Who is watching the canary?' }, { kind: 'handoff', botSlug: 'coder' }],
  });
  reply = 'Posted my answer above.';
} else if (channel === 'support' && /\bdraft\b/i.test(question)) {
  // the Support responder: it writes the customer's reply as a message of its own; the bot's definition says a person must approve a post, so the platform holds it
  await call('messages.post', { body: 'Hi, thanks for writing in. You can change the delivery address of an order until it has shipped: open the order in your account, choose Change delivery address and save. If it has already shipped, send the carrier your tracking number.' });
  // the call answered "approval_pending": a model that is told so stops there and says nothing more (the card in the thread is the answer)
  reply = '';
} else if (/refund/i.test(question)) {
  const recalled = await call('memory.recall', { query: 'refund policy' });
  const concept = /"(?:conceptPath|path)":"([^"]*refund[^"]*)"/.exec(JSON.stringify(recalled))?.[1];
  const found = await call('messages.search', { query: 'refund' });
  const hits = channelHits(found);
  await call('answer.post', {
    body: 'Refunds up to 30 days after a charge need no approval [1]. Anything older goes to the team lead with the ticket number.',
    citations: [...(concept ? [{ kind: 'memory', conceptPath: concept, snippet: 'Refunds up to 30 days after a charge need no approval.' }] : []), ...hits.slice(0, 1).map((h) => ({ kind: 'message', messageId: h.id, snippet: h.snippet }))],
    chips: [{ kind: 'followup', prompt: 'What do I tell the customer?', label: 'What do I tell the customer?' }],
  });
  reply = 'Posted my answer above.';
} else if (/\borchestrate\b/i.test(question)) {
  // the Orchestrator's first steps (PLAN P10-16): the Bot Board of this channel (made once, found again by a second request), then one card for each bot that will work on the change
  const goal = question.replace(/^.*?\borchestrate:?\s*/i, '').slice(0, 90);
  const branch = `bot-board/${goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
  await call('boards.ensure', {});
  for (const verb of ['Code', 'Review', 'Test', 'Deploy', 'Browser test']) {
    await call('tasks.create', { title: `${verb}: ${goal}`, description: `The ${verb.toLowerCase()} step of: ${goal}`, branch });
  }
  reply = 'The cards for this change are on the Bot Board of this channel: Code, Review, Test, Deploy and Browser test.';
} else if (/engineering/i.test(question)) {
  await call('answer.post', {
    body: 'I can only answer from what Customer support can read, and nothing here covers that. Ask Engineering to share it with your team.',
    outsideScope: [{ kind: 'message', count: 3 }, { kind: 'page', count: 1 }],
  });
  reply = 'Posted my answer above.';
}
process.stdout.write(`${JSON.stringify({ type: 'text', text: 'Answering: ' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } })}\n`);
