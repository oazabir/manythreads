// The stand-in for `hermes chat --oneshot --format stream-json` of the Chat screen specs (PLAN P20-16 / P20-T4). Like fake-hermes.mjs it reads the prompt on
// stdin and answers with one JSON record per line, but it can also be slow, so a spec can look at the live parts of a run. There is no model behind it.
//
//   SLOW      writes two pieces ("Working on " "it") and then waits two minutes: a run that is open until the asker presses Stop.
//   STREAM    looks at memory, then writes six pieces of a sentence, one every 600 ms: the live preview, the "looking at" line and Stop have time to be seen.
//   FIXED     answers at once with the same sentence every time (the visual specs, which compare pixels).
//   anything  echoes the prompt (as fake-hermes.mjs does) and adds a short random tag, so two answers to the same question differ and a spec can tell the
//             variants of Ask again apart.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8').trim();
const line = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = Math.random().toString(16).slice(2, 8);
const echo = `Answering: ${prompt.replace(/\s+/g, ' ')}`;

if (prompt.includes('SLOW')) {
  line({ type: 'text', text: 'Working on ' });
  line({ type: 'text', text: 'it' });
  await wait(120_000);
}
if (prompt.includes('FIXED')) {
  line({ type: 'result', exit_code: 0, text: 'Two things block the release: the QA batch 7 numbers and the Monday change window.', tokens: { input: 5, output: 5, total: 10 } });
} else if (prompt.includes('STREAM')) {
  line({ type: 'tool_use', name: 'memory_search', input: { query: 'x' } });
  const pieces = ['The ', 'release ', 'is ', 'waiting ', 'for ', 'Monday.'];
  for (const text of pieces) {
    await wait(600);
    line({ type: 'text', text });
  }
  line({ type: 'result', exit_code: 0, text: `${pieces.join('')} (${tag})`, tokens: { input: 5, output: 5, total: 10 } });
} else {
  line({ type: 'text', text: 'Answering: ' });
  line({ type: 'result', exit_code: 0, text: `${echo} (${tag})`, tokens: { input: 5, output: 5, total: 10 } });
}
