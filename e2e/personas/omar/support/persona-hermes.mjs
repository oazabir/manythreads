// The Hermes stand-in of the Omar, Rafi and Priya journeys (PLAN P12-03). It plays the part of the model for a bot placed on the Hermes runtime, over the run's own
// MCP door, so the platform's real tools, grants, approvals and answer checks do the work; only the decision a model would make is scripted:
//
//   WRITE-PAGE <path> <words...>  the bot asks to create that page with `pages.write` (a grant that needs approval holds it until a person decides) and says so
//   anything else                 look the question up with `messages.search` and finish with an Answer that cites what was found (`answer.post`), or, where an
//                                 Answer has nowhere to go (a mention in a channel), reply in plain words with the first thing found
//
// Nothing in here is keyed to one journey: the words of the question are the search, and what comes back is what the person is allowed to read.
import { readFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8').trim();

/** Calls a tool of the run's own endpoint; answers the parsed JSON the gateway wrapped in `content[0].text` (or `{ error }`). */
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

const STOP = new Set('a an and are as at be but by can could do does for from had has have how i if in is it its me my of on or our please so that the their there this to us was we were what when where which who why will with would you your hello hi hey thanks thank dear brain coder tell show find need want get'.split(' '));
const asked = prompt.includes(':\n\n') ? prompt.slice(prompt.indexOf(':\n\n') + 3) : prompt;
const words = [...new Set(asked.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 5);

const say = (text) => {
  process.stdout.write(`${JSON.stringify({ type: 'text', text: 'Looking. ' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'result', exit_code: 0, text, tokens: { input: 5, output: 5, total: 10 } })}\n`);
};

const write = /WRITE-PAGE (\S+)\s*(.*)/.exec(asked);
if (write) {
  const result = await call('pages.write', { mode: 'create', path: write[1], content: write[2] || `Written by the stand-in: ${write[1]}` });
  const waiting = result?.code === 'approval_pending' || /approval/i.test(JSON.stringify(result));
  say(waiting ? `I asked for approval to create ${write[1]}. It waits for a person to decide.` : `I created ${write[1]}.`);
} else {
  // one search per word and one for all of them together: a message is found if any of them matches, as a person would try again
  const queries = [words.join(' '), ...words].filter((q) => q.length >= 2);
  const hits = new Map();
  for (const q of queries) {
    const found = await call('messages.search', { query: q, limit: 5 });
    // what the team wrote in its channels: not a person's own chat with a bot, and not a message that is only a request to a bot
    for (const h of found?.hits ?? []) {
      if (h.channel?.kind !== 'channel' || /^@\w+/.test(String(h.snippet ?? '').replace(/<[^>]+>/g, '').trim())) continue;
      if (!hits.has(h.id)) hits.set(h.id, h);
    }
    if (hits.size >= 3) break;
  }
  const top = [...hits.values()].slice(0, 3);
  if (top.length === 0) {
    say('I could not find anything the team has written about that.');
  } else {
    const snip = (h) => String(h.snippet ?? '').replace(/<[^>]+>/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const body = `Here is what the team wrote. ${top.map((h, i) => `${snip(h)} [${i + 1}]`).join(' ')}`;
    const posted = await call('answer.post', {
      body,
      citations: top.map((h) => ({ kind: 'message', messageId: h.id, snippet: snip(h).slice(0, 120) })),
      chips: [{ kind: 'followup', prompt: 'Who wrote that?', label: 'Who wrote that?' }],
    });
    if (posted?.ok === true) say('Posted my answer above.');
    else say(body);
  }
}
