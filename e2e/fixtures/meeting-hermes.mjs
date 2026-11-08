// A stand-in for the Hermes command, for the meeting specs and the `meetings` stack seed (PLAN P15-17). `MANYTHREADS_HERMES_BIN` is `node` and
// `MANYTHREADS_HERMES_PREFIX` is this file, so a bot run of the stack starts `node meeting-hermes.mjs` with the prompt on stdin and reads one JSON line back.
// It never calls a tool and never reaches a network; what it answers is worked out from the prompt by plain rules, so a spec knows what comes back:
//
//   "Write the notes of a meeting."        the Scribe's and the note-taker's notes. A line with "decided", "decision" or "agreed" is a decision; "I will" or "I'll"
//                                          is an action for the speaker; "can you" or "please" with no taker is an action with no owner; a line ending in "?" is
//                                          a question; YYYY-MM-DD in a line is its due date. A line starting with "CRASH" makes the model fall over.
//   "Answer a question asked in a meeting." one sentence that repeats the question (so a spec sees what the run was given). With "SEARCH-MEETINGS <words>" in the question
//                                          the run first reads the meetings it may see (the `meetings.search` tool), as a model that looks things up would.
//   "ANSWER-FROM-MEETINGS <words>" anywhere in the prompt (a person asking the Brain in a conversation): searches the team's meetings for <words> over the run's own
//                                          MCP endpoint, as a model that reads before it cites would, then finishes with the `answer.post` tool citing the first hit's
//                                          meeting at that hit's time. With no hit it answers that it found nothing and cites nothing.
//   "ECHO-ME" anywhere in the prompt (a bot a spec mentions)  a reply that repeats the prompt, so a spec sees what the run was given.
//   "An event arrived from ..." (a work app's webhook run, P16-10)  one sentence with the event's kind and title.
//   anything else (the Archivist's drop)   one Meeting concept named after the item.
//
// Every prompt is appended to the file named by HERMES_FAKE_SPOOL (when set) as one JSON line, so a spec can read what the model was shown.
import { appendFileSync, readFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8').trim();
const first = prompt.split('\n')[0] ?? '';
if (process.env.HERMES_FAKE_SPOOL) appendFileSync(process.env.HERMES_FAKE_SPOOL, JSON.stringify({ at: Date.now(), first, prompt }) + '\n');
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const reply = (text) => out({ type: 'result', exit_code: 0, text, tokens: { input: 5, output: 5, total: 10 } });

// the run's own MCP endpoint and bearer token are in the profile the platform rendered (`$HERMES_HOME/config.yaml`)
function toolCaller() {
  const config = readFileSync(`${process.env.HERMES_HOME ?? ''}/config.yaml`, 'utf8');
  const url = JSON.parse(/^\s+url: (.*)$/m.exec(config)[1]);
  const bearer = JSON.parse(/Authorization: (.*)$/m.exec(config)[1]);
  let rpcId = 0;
  return async (name, args) => {
    const res = await fetch(url, { method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method: 'tools/call', params: { name, arguments: args } }) });
    const raw = await res.text();
    if (process.env.HERMES_FAKE_SPOOL) appendFileSync(process.env.HERMES_FAKE_SPOOL, JSON.stringify({ at: Date.now(), tool: name, status: res.status, reply: raw.slice(0, 2000) }) + '\n');
    return raw;
  };
}

if (first === 'Write the notes of a meeting.') {
  const start = prompt.indexOf('----- TRANSCRIPT -----');
  const end = prompt.indexOf('----- END OF TRANSCRIPT -----');
  const body = start >= 0 ? prompt.slice(start, end > start ? end : undefined) : '';
  const rows = [];
  for (const raw of body.split('\n')) {
    const m = /^@(\d+) \| [^|]* \| ([^:]{1,80}): (.+)$/.exec(raw.trim());
    if (m) rows.push({ atMs: Number(m[1]), speaker: m[2].trim(), text: m[3].trim() });
  }
  if (rows.some((r) => r.text.startsWith('CRASH'))) {
    out({ type: 'result', exit_code: 1, text: '', error: 'model fell over' });
    process.exit(1);
  }
  const speakers = [...new Set(rows.map((r) => r.speaker))];
  const notes = {
    summary: rows.length === 0 ? 'Nothing was said in this meeting.' : `${speakers.join(' and ')} talked for ${rows.length} lines and settled the release plan.`,
    decisions: rows.filter((r) => /\b(decided|decision|agreed)\b/i.test(r.text)).slice(0, 5).map((r) => ({ text: r.text, atMs: r.atMs })),
    actionItems: rows
      .filter((r) => /\b(i will|i'll|can you|please)\b/i.test(r.text))
      .slice(0, 5)
      .map((r) => ({ text: r.text, owner: /\b(i will|i'll)\b/i.test(r.text) ? r.speaker : null, due: /\b(\d{4}-\d{2}-\d{2})\b/.exec(r.text)?.[1] ?? null, atMs: r.atMs })),
    questions: rows.filter((r) => r.text.endsWith('?')).slice(0, 5).map((r) => ({ text: r.text, atMs: r.atMs })),
  };
  reply('Here are the notes:\n```json\n' + JSON.stringify(notes) + '\n```');
} else if (prompt.includes('ANSWER-FROM-MEETINGS')) {
  const tool = toolCaller();
  const words = /ANSWER-FROM-MEETINGS ([^\n]{1,200})/.exec(prompt)?.[1]?.trim() ?? 'meeting';
  const found = await tool('meetings.search', { query: words });
  // the hits are inside the tool result text, as JSON objects that each name a meeting; one said aloud (a time past zero) is cited before the notes
  const parseHits = (text) => [...text.matchAll(/\{[^{}]*"meetingId"[^{}]*\}/g)].map((m) => { try { return JSON.parse(m[0]); } catch { return null; } }).filter((h) => h && typeof h.meetingId === 'string');
  const hits = [...parseHits(found), ...parseHits(found.replaceAll('\\"', '"'))];
  const hit = hits.find((h) => Number(h.atMs ?? 0) > 0) ?? hits[0];
  if (hit) {
    await tool('answer.post', {
      body: `It was said in the meeting [1]: ${String(hit.snippet ?? '').slice(0, 200)}`,
      citations: [{ kind: 'meeting', meetingId: hit.meetingId, atMs: Number(hit.atMs ?? 0), snippet: String(hit.snippet ?? '').slice(0, 200) }],
    });
  } else {
    await tool('answer.post', { body: 'I did not find that in the meetings I may read.' });
  }
  reply('Posted my answer above.');
} else if (first.startsWith('An event arrived from ')) {
  // a bot whose `webhook` trigger fired (P16-10, the `connectors` seed): it says what it was told, so a spec sees the run was given the title and not the secret
  const title = /^title: (.*)$/m.exec(prompt)?.[1]?.trim() ?? '(none)';
  const kind = /^- kind: (.*)$/m.exec(prompt)?.[1]?.trim() ?? 'event';
  reply(`Noted a ${kind}: ${title.slice(0, 200)}. I will look at it.`);
} else if (prompt.includes('ECHO-ME')) {
  // a bot of a spec that is mentioned or asked something: it repeats what it was given, as the conversation stand-in of the conversation specs does
  reply(`Answering: ${prompt.replace(/\s+/g, ' ').slice(0, 600)}`);
} else if (first === 'Answer a question asked in a meeting.') {
  const start = prompt.indexOf('----- QUESTION -----');
  const end = prompt.indexOf('----- END OF QUESTION -----');
  const q = start >= 0 ? prompt.slice(start + '----- QUESTION -----'.length, end > start ? end : undefined).trim() : '';
  // "SEARCH-MEETINGS <words>" in the question: the run reads the meetings it may see first, as a model that looks things up would
  const looked = /SEARCH-MEETINGS ([^\n?]{1,100})/.exec(q)?.[1]?.trim();
  if (looked) await toolCaller()('meetings.search', { query: looked });
  reply(`From what this room may read: we ship on Thursday morning. You asked: ${q.slice(0, 200)}`);
} else {
  const name = /^Name: (.*)$/m.exec(prompt)?.[1] ?? 'Meeting';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'meeting';
  reply(JSON.stringify([{ path: `memory/meetings/${slug}.md`, type: 'Meeting', title: name, description: 'Filed by the meeting stand-in', tags: ['meeting'], body: `${name}: the team met and settled the plan.` }]));
}
