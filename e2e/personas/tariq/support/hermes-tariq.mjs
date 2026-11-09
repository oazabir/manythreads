// The Hermes stand-in of Tariq's journeys (PLAN P12-03; Bundle E decision E31): there is no model behind it. Like the other stand-ins it reads the prompt on stdin and answers with
// JSON lines, calling the run's own MCP door so the platform's real tools, grants, guard and answer checks do the work; only the words are written in advance.
//
//   Content drafter, a brief that asks for a "launch announcement"   writes pages/drafts/launch-announcement.md with `pages.write`, then tells the thread where it is
//   Brain, a question about the "brand voice"                         searches the team's messages and memory, finishes with an Answer citing what it found
//   Brain, a question that names a "Drive" (somebody else's)          an Answer whose only citation is a message Tariq may not read (its id is in `closed-source.txt`, next to the profile
//                                                                    folders, put there by journey T9); the stand-in declares nothing out of scope: the platform's own check of the
//                                                                    citation decides, and what the Answer lists under Outside scope is its doing
//   anything else                                                     echo
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8').trim();

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
    const text = body?.result?.content?.[0]?.text;
    if (typeof text !== 'string') return { error: body?.error ?? body };
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  } catch {
    return { error: `HTTP ${res.status}` };
  }
};

const asked = (prompt.includes(':\n\n') ? prompt.slice(prompt.indexOf(':\n\n') + 3) : prompt).replace(/\s+/g, ' ');
const snip = (h) => String(h.snippet ?? '').replace(/<[^>]+>/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);

let reply = `Answering: ${prompt.replace(/\s+/g, ' ')}`;
if (/launch announcement/i.test(asked)) {
  const path = 'pages/drafts/launch-announcement.md';
  const draft = [
    '# Launch announcement: saved filters on the orders page',
    '',
    'Orders you check every day are now one click away.',
    '',
    '## What is new',
    '',
    '- Save the filters you use most and open them from a list.',
    '- Share a saved filter with the rest of your team.',
    '',
    '## Who it is for',
    '',
    'Anyone who works through orders every morning.',
    '',
  ].join('\n');
  const written = await call('pages.write', { mode: 'create', path, content: draft });
  const failed = written?.error !== undefined;
  reply = failed ? 'I could not save the draft; a person needs to look at my tools.' : `The draft is in ${path}. It is for people who work through orders every day. The Brand reviewer reads it next.`;
} else if (/weekly social/i.test(prompt)) {
  // a routine's reply is its page: the platform writes it to the contract's output path as the bot
  reply = [
    '# Weekly social round-up',
    '',
    '## Posts this week',
    '',
    '- Monday: the saved filters on the orders page, one short post with a screenshot.',
    '- Wednesday: a customer question we answered this month.',
    '- Friday: what shipped, in three lines.',
    '',
    '## For the Brand reviewer',
    '',
    'Each post is a draft until a person approves it.',
    '',
  ].join('\n');
} else if (/brand voice|brand guid/i.test(asked)) {
  const hits = new Map();
  for (const query of ['voice', 'avoid']) {
    const found = await call('messages.search', { query, limit: 5 });
    for (const h of found?.hits ?? []) if (h.channel?.kind === 'channel' && !hits.has(h.id)) hits.set(h.id, h);
    if (hits.size >= 2) break;
  }
  const top = [...hits.values()].slice(0, 2);
  const recalled = await call('memory.recall', { query: 'brand voice' });
  const concept = /"(?:conceptPath|path)":"([^"]+)"/.exec(JSON.stringify(recalled))?.[1];
  const citations = [
    ...top.map((h) => ({ kind: 'message', messageId: h.id, snippet: snip(h).slice(0, 120) })),
    ...(concept && top.length === 0 ? [{ kind: 'memory', conceptPath: concept, snippet: 'How the team writes' }] : []),
  ];
  await call('answer.post', {
    body: `The voice is plain, specific and a little dry: say what the product does and do not oversell [1]. ${citations.length > 1 ? 'Avoid the words the style guide lists, such as "seamless" and "unlock" [2]. ' : ''}Never promise a date for the roadmap.`,
    citations,
    chips: [{ kind: 'followup', prompt: 'Show an example headline', label: 'Show an example headline' }],
  });
  reply = 'Posted my answer above.';
} else if (/drive/i.test(asked)) {
  // Nobody here can reach another person's Drive (no connection of Omar's exists in this stack), so the refusal that can be proved is the platform's check of a citation: the stand-in cites
  // a message of a channel Tariq cannot read and says nothing about scope itself. `outsideScope` is left out on purpose: whatever the Answer lists is the server's own finding.
  let closed = '';
  let word = '';
  try {
    [closed = '', word = ''] = readFileSync(join(dirname(process.env.HERMES_HOME ?? ''), 'closed-source.txt'), 'utf8').trim().split('\n');
  } catch {
    closed = '';
  }
  // the run searches as Tariq, through the platform: the closed message is not among what it finds (the count is the platform's answer, not a figure written in advance)
  const found = word === '' ? null : await call('messages.search', { query: word });
  const mine = Array.isArray(found?.hits) ? found.hits.filter((h) => h?.id === closed).length : null;
  await call('answer.post', {
    body: `I can only read what you may read. I did not open anyone else's files. My search for the message found ${mine === null ? 'an error' : `${mine} messages`}. Ask the owner to share what you need with the team.`,
    citations: closed === '' ? [] : [{ kind: 'message', messageId: closed, snippet: 'A message of a channel Tariq cannot read' }],
  });
  reply = 'Posted my answer above.';
}
process.stdout.write(`${JSON.stringify({ type: 'text', text: 'Answering: ' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } })}\n`);
