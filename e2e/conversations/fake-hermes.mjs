// The stand-in for `hermes chat --oneshot --format stream-json` that the conversation specs start the server with (MANYTHREADS_HERMES_BIN is
// node, MANYTHREADS_HERMES_PREFIX is this file). It reads the prompt on stdin and answers with one JSON record per line, repeating what it was
// asked, so a spec can see that the person's message — and nothing else of the run — reached the bot. The same shape as the stand-in of
// packages/plugins/runtime-hermes/test/run.test.ts; there is no model behind it.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8').trim();
const reply = `Answering: ${prompt.replace(/\s+/g, ' ')}`;
process.stdout.write(`${JSON.stringify({ type: 'text', text: 'Answering: ' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } })}\n`);
