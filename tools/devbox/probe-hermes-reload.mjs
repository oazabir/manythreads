#!/usr/bin/env node
// probe-hermes-reload.mjs — what a Hermes gateway reads live and what it reads once (PLAN P14-22). Run it after every Hermes upgrade (about two minutes).
//
// It makes a throwaway profile on the host gateway with NO shell and NO files toolset (only `todo`), points its MCP server at a stand-in that this script
// runs on 127.0.0.1, asks the five questions below through the same `/p/<profile>/v1/runs` API `runtime-hermes` uses, and removes the profile at the end
// (also on an error or Ctrl-C; a profile left behind by a kill is removed by the next run once it is an hour old). The gateway must multiplex profiles
// (`hermes gateway list` shows the other profiles as "served by the default multiplexer"): a profile directory is picked up by itself within about 30 s, and
// the probe waits for that instead of starting a gateway. It never touches another profile and never restarts the gateway process: `gateway restart` here is
// `hermes -p <throwaway> gateway restart`, which serves that one profile again through the control socket.
//
// The five questions (each asked in a fresh run; answers are one word, so a model cannot hide a wrong answer in prose):
//   Q1 which `probe_*` tools do you have?                          (the MCP tool list)
//   Q2 what is the secret word of your identity?                   (SOUL.md)
//   Q3 what is the code word of this turn?                         (the per-run `instructions`)
//   Q4 which tools can you call (is `todo` among them)?            (config.yaml toolsets)
//   Q5 Q1 again, after the input `/reload-mcp`                     (whether that is a command)
// and what they say about (a) to (g) — the rows of the table in docs/plugins/runtime-hermes.md ("When a bot's definition or tools change"):
//   (a) toolsets in config.yaml are read per request   (b) SOUL.md is frozen per thread   (c) `instructions` apply on every turn, also in an old thread
//   (d) the MCP tool list is read once, when the profile is served; a re-serve fixes it
//   (e) a `notifications/tools/list_changed` push fixes it with no restart (session id + listChanged: true + the GET stream)
//   (f) .env and the MCP token are read when the profile is served   (g) `/reload-mcp` as input is not a command
//
// Usage on the devbox, from the repo root:   node tools/devbox/probe-hermes-reload.mjs [--keep] [--only=a,d,e]
//   node tools/devbox/probe-hermes-reload.mjs --self-test     checks the stand-in server alone (no Hermes, no model call)
// Env: HERMES_HOME (/root/.hermes), HERMES_BIN (hermes), PROBE_GATEWAY (default: API_SERVER_HOST and API_SERVER_PORT from $HERMES_HOME/.env). The model block is the devbox's own
// (the one provision-host-bots.mjs writes); its key is read from $HERMES_HOME/.env and never printed.
// Exit 0 when every row matches what Hermes v0.21.5 did on 2026-11-01, 1 when one differs (the table says which), 2 when it could not run.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shortHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The stand-in MCP server: an editable tool list, an optional session id + `listChanged: true` + GET event stream (the push), and a record of what
// Hermes asked and with which token. Exported so the self-test (and a unit check) can run it without Hermes.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const FRAME = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n';
const toolOf = (name) => ({ name, description: `Probe tool ${name}. It does nothing.`, inputSchema: { type: 'object', properties: {} } });

export async function startStandIn({ tokens = ['token-1'], push = false } = {}) {
  const state = { tools: [toolOf('probe_one')], push, tokens: new Set(tokens), lists: 0, inits: 0, streamsOpened: 0, lastToken: null, streams: new Set() };
  const server = createServer((req, res) => {
    const auth = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '');
    state.lastToken = auth ? shortHash(auth[1]) : null;
    if (!auth || !state.tokens.has(auth[1])) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && state.push && String(req.headers['accept'] ?? '').includes('text/event-stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      res.write(': open\n\n');
      state.streams.add(res);
      state.streamsOpened += 1;
      const keep = setInterval(() => res.write(': keepalive\n\n'), 15_000);
      res.on('close', () => {
        clearInterval(keep);
        state.streams.delete(res);
      });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const reply = (result, headers = {}) => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (msg.method === 'initialize') {
        state.inits += 1;
        reply(
          { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: { listChanged: state.push } }, serverInfo: { name: 'probe-stand-in', version: '1' } },
          state.push ? { 'mcp-session-id': `probe-session-${state.inits}` } : {},
        );
      } else if (msg.method === 'tools/list') {
        state.lists += 1;
        reply({ tools: state.tools });
      } else if (msg.method === 'tools/call') {
        reply({ content: [{ type: 'text', text: 'ok' }] });
      } else if (msg.method === 'ping') {
        reply({});
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    state,
    addTool: (name) => void state.tools.push(toolOf(name)),
    /** Sends `list_changed` to every open stream. */
    pushChange: () => {
      for (const s of state.streams) s.write(FRAME);
    },
    close: () => {
      for (const s of state.streams) s.end();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The self-test: the stand-in against a tiny client. No Hermes, no model.
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function selfTest() {
  const fails = [];
  const check = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) fails.push(what);
  };
  const post = (url, token, method, headers = {}) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { protocolVersion: '2024-11-05' } }) });
  const quiet = await startStandIn({ push: false });
  const noPush = await post(quiet.url, 'token-1', 'initialize');
  check(noPush.headers.get('mcp-session-id') === null && (await noPush.json()).result.capabilities.tools.listChanged === false, 'without push: no session id, listChanged false');
  check((await fetch(quiet.url, { headers: { accept: 'text/event-stream', authorization: 'Bearer token-1' } })).status === 405, 'without push: GET is 405');
  check((await post(quiet.url, 'wrong', 'tools/list')).status === 401, 'a wrong token is 401');
  await quiet.close();

  const loud = await startStandIn({ push: true });
  const init = await post(loud.url, 'token-1', 'initialize');
  check(init.headers.get('mcp-session-id')?.startsWith('probe-session-') && (await init.json()).result.capabilities.tools.listChanged === true, 'with push: a session id and listChanged true');
  const controller = new AbortController();
  const stream = await fetch(loud.url, { headers: { accept: 'text/event-stream', authorization: 'Bearer token-1' }, signal: controller.signal });
  check(stream.status === 200, 'with push: GET opens an event stream');
  let text = '';
  void (async () => {
    try {
      for await (const chunk of stream.body) text += Buffer.from(chunk).toString('utf8');
    } catch {
      /* closed */
    }
  })();
  await sleep(50);
  loud.addTool('probe_two');
  loud.pushChange();
  await sleep(100);
  check(text.includes('notifications/tools/list_changed'), 'pushChange sends list_changed on the stream');
  const listed = await (await post(loud.url, 'token-1', 'tools/list')).json();
  check(listed.result.tools.map((t) => t.name).join() === 'probe_one,probe_two' && loud.state.lists === 1, 'tools/list shows the added tool and is counted');
  check(loud.state.lastToken === shortHash('token-1'), 'the token of the last request is recorded (as a short hash)');
  controller.abort();
  await loud.close();
  console.log(fails.length === 0 ? 'self-test: all good' : `self-test: ${fails.length} failed`);
  return fails.length === 0 ? 0 : 1;
}

if (process.argv.includes('--self-test')) {
  process.exit(await selfTest());
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The probe proper. Everything below runs only when this file is the entry point (the self-test and an import stop above or below).
// ---------------------------------------------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await probe()); // imported for startStandIn: run nothing

async function probe() {
  const HOME = process.env['HERMES_HOME'] ?? '/root/.hermes';
  const BIN = process.env['HERMES_BIN'] ?? 'hermes';
  const hostEnv = (() => {
    try {
      return readFileSync(join(HOME, '.env'), 'utf8');
    } catch {
      return '';
    }
  })();
  const envValue = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(hostEnv)?.[1]?.trim().replace(/^["']|["']$/g, '');
  const GATEWAY = (process.env['PROBE_GATEWAY'] ?? `http://${envValue('API_SERVER_HOST') ?? '127.0.0.1'}:${envValue('API_SERVER_PORT') ?? '8642'}`).replace(/\/+$/, '');
  const keep = process.argv.includes('--keep');
  const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
  const wants = (row) => only.length === 0 || only.includes(row);
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const profile = `probe-reload-${process.pid}`;
  const dir = join(HOME, 'profiles', profile);
  const apiKey = randomBytes(24).toString('hex');
  if (!existsSync(join(HOME, 'profiles'))) {
    console.error(`no ${join(HOME, 'profiles')}: is HERMES_HOME right?`);
    return 2;
  }

  // Leftovers of a probe that was killed (SIGKILL cannot be caught): older than an hour, so a probe running right now is never touched.
  for (const entry of readdirSync(join(HOME, 'profiles'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^probe-reload-\d+$/.test(entry.name)) continue;
    const old = Date.now() - statSync(join(HOME, 'profiles', entry.name)).mtimeMs > 3_600_000;
    if (old) {
      rmSync(join(HOME, 'profiles', entry.name), { recursive: true, force: true });
      console.log(`removed a stale ${entry.name}`);
    }
  }

  // The host's own LiteLLM key (read, never printed) so the model can answer; the profile gets it as a plain env line.
  const llmKey = envValue('LITELLM_API_KEY') ?? '';
  if (llmKey === '') {
    console.error(`LITELLM_API_KEY is not in ${join(HOME, '.env')}: the probe needs a model to ask its questions`);
    return 2;
  }
  // The platform's own grant -> toolset mapping, with no grant at all: only `todo` on, shell, files and the rest off.
  const { hermesToolsets } = await import(pathToFileURL(join(repoRoot, 'packages', 'plugins', 'runtime-hermes', 'src', 'toolsets.ts')).href);
  const base = hermesToolsets([]);
  const quote = (list) => `[${list.map((t) => JSON.stringify(t)).join(', ')}]`;

  let standIn = null;
  let cleaned = false;
  const writeFiles = ({ soul, mcpToken, enabled = base.enabled, disabled = base.disabled, url = standIn.url }) => {
    const config = `# throwaway profile of tools/devbox/probe-hermes-reload.mjs; it removes itself.
model:
  default: "default"
  provider: "custom:litellm"
  base_url: "https://litellm-hetzner.kahf.to/v1"
providers:
  litellm:
    base_url: https://litellm-hetzner.kahf.to/v1
    key_env: LITELLM_API_KEY
    default_model: default
    models:
      default: {context_length: 262144}
mcp_servers:
  manythreads:
    url: "${url}"
    headers:
      Authorization: "Bearer \${MANYTHREADS_MCP_TOKEN}"
    timeout: 60
    connect_timeout: 15
platform_toolsets:
  api_server: ${quote(enabled)}
agent:
  disabled_toolsets: ${quote(disabled)}
tools:
  tool_search:
    enabled: "off"
`;
    const env = `API_SERVER_KEY=${apiKey}\nMANYTHREADS_MCP_TOKEN=${mcpToken}\nLITELLM_API_KEY=${llmKey}\n`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [name, text] of [['config.yaml', config], ['.env', env], ['SOUL.md', soul]]) {
      writeFileSync(join(dir, name), text, { mode: 0o600 });
      chmodSync(join(dir, name), 0o600);
    }
  };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await standIn?.close().catch(() => undefined);
    if (keep) return;
    rmSync(dir, { recursive: true, force: true }); // the gateway stops serving a profile whose directory is gone; wait until it says so
    for (let i = 0; i < 40 && listed() !== null; i += 1) await sleep(1_500);
    console.log(listed() === null ? `profile ${profile} removed and no longer served` : `profile ${profile}: directory removed, but the gateway still lists it (it drops it within about 30 s)`);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => void cleanup().then(() => process.exit(130)));

  /** The gateway's own line for the profile ("served by the default multiplexer", "not running"), or null when it does not list it. */
  const listed = () => {
    try {
      const out = execFileSync(BIN, ['gateway', 'list'], { env: { ...process.env, HERMES_HOME: HOME }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
      const line = out.split('\n').find((l) => l.replace(/^[^A-Za-z0-9]+/, '').split(/\s+/)[0] === profile);
      return line ? line.replace(/^[^A-Za-z0-9]+/, '').replace(/^\S+\s*[—-]\s*/, '').trim() : null;
    } catch {
      return null;
    }
  };
  const answers = async () => {
    try {
      return (await fetch(`${GATEWAY}/p/${profile}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5_000) })).status === 200;
    } catch {
      return false;
    }
  };
  /** Waits until the multiplexer serves the profile and its API answers with the profile's key; one `gateway restart` of that profile if it is not served after 15 s. */
  const serve = async () => {
    let restarted = false;
    const started = Date.now();
    for (;;) {
      if ((listed() ?? '').includes('served by the default multiplexer') && (await answers())) return true;
      const waited = Date.now() - started;
      if (waited > 15_000 && !restarted) {
        restarted = true;
        console.log('not served after 15 s: hermes gateway restart of this profile');
        hermes('restart');
      }
      if (waited > 90_000) return false;
      await sleep(2_000);
    }
  };

  const hermes = (verb) => {
    try {
      execFileSync(BIN, ['-p', profile, 'gateway', verb], { env: { ...process.env, HERMES_HOME: HOME }, stdio: 'pipe', timeout: 90_000 });
      return true;
    } catch (e) {
      console.error(`hermes -p ${profile} gateway ${verb} failed: ${String(e.stderr ?? e.message).slice(-200)}`);
      return false;
    }
  };

  // One run, read to its end. The answer is the run's final output.
  const ask = async (input, { session, instructions } = {}) => {
    const sessionId = session ?? `probe-${randomBytes(6).toString('hex')}`;
    const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': randomBytes(12).toString('hex') };
    const start = await fetch(`${GATEWAY}/p/${profile}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ input, session_id: sessionId, ...(instructions ? { instructions } : {}) }) });
    if (start.status !== 202 && start.status !== 200) throw new Error(`start answered HTTP ${start.status}`);
    const { run_id: runId } = await start.json();
    const events = await fetch(`${GATEWAY}/p/${profile}/v1/runs/${runId}/events`, { headers: { authorization: `Bearer ${apiKey}`, accept: 'text/event-stream' }, signal: AbortSignal.timeout(150_000) });
    let buffer = '';
    for await (const chunk of events.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      for (const block of buffer.split('\n\n')) {
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!data) continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.event === 'run.completed' || event.type === 'run.completed') return { sessionId, answer: String(event.output ?? event.data?.output ?? '') };
        if (event.event === 'run.failed' || event.type === 'run.failed') throw new Error('the run failed');
      }
    }
    throw new Error('the event stream ended without an answer');
  };
  const word = (answer, words) => words.find((w) => new RegExp(`\\b${w}\\b`, 'i').test(answer)) ?? `(none of ${words.join('/')}: ${answer.slice(0, 60).replace(/\s+/g, ' ')})`;
  const probeTools = async (extra = {}) => {
    const { answer } = await ask("List the exact names of every tool you can call whose name contains 'probe_', separated by commas, and nothing else. If there are none, answer NONE.", extra);
    return [...new Set([...answer.matchAll(/probe_[a-z]+/g)].map((m) => m[0]))].sort().join(',') || 'NONE';
  };

  const rows = [];
  const record = (row, what, expected, observed) => {
    const ok = observed === expected;
    rows.push({ row, what, expected, observed, ok });
    console.log(`${ok ? 'ok  ' : 'DIFF'} (${row}) ${what}: ${observed}${ok ? '' : `   [Hermes 0.21.5 gave: ${expected}]`}`);
  };

  try {
    standIn = await startStandIn({ tokens: ['token-1', 'token-2'], push: false });
    writeFiles({ soul: 'The secret word of your identity is ALPHA. If asked for it, answer with that one word.\n', mcpToken: 'token-1' });
    console.log(`profile ${profile} written (throwaway, no shell, no files toolset); waiting for the gateway to serve it`);
    if (!(await serve())) {
      console.error(`the gateway did not serve ${profile} within 90 s (gateway ${GATEWAY}; \`${BIN} gateway list\` says: ${listed() ?? 'nothing'})`);
      return 2;
    }
    console.log(`served: ${listed()}`);

    // (a) toolsets are read on every request.
    if (wants('a')) {
      // the whole tool list is asked for (a yes/no about one name was answered NO even with the toolset on); `todo` is the one harmless toolset the profile enables
      const hasTodo = async () => {
        const { answer } = await ask('List the exact names of every tool you can call, separated by commas, on one line, and nothing else.');
        console.log(`    (a) tools named: ${answer.replace(/\s+/g, ' ').slice(0, 160)}`);
        return /todo/i.test(answer) ? 'YES' : 'NO';
      };
      const before = await hasTodo();
      writeFiles({ soul: readFileSync(join(dir, 'SOUL.md'), 'utf8'), mcpToken: 'token-1', enabled: [], disabled: [...base.disabled, ...base.enabled] });
      const after = await hasTodo();
      writeFiles({ soul: readFileSync(join(dir, 'SOUL.md'), 'utf8'), mcpToken: 'token-1' });
      record('a', 'toolsets edited in config.yaml: todo before, after (no restart)', 'YES>NO', `${before}>${after}`);
    }

    // (b) SOUL.md is frozen per thread; (c) instructions are not.
    if (wants('b')) {
      const askSoul = (extra) => ask('What is the secret word of your identity? Answer with that one word.', extra).then((r) => ({ ...r, word: word(r.answer, ['ALPHA', 'BRAVO']) }));
      const first = await askSoul();
      writeFiles({ soul: 'The secret word of your identity is BRAVO. If asked for it, answer with that one word.\n', mcpToken: 'token-1' });
      const sameThread = await askSoul({ session: first.sessionId });
      const newThread = await askSoul();
      record('b', 'SOUL.md ALPHA>BRAVO: old thread, new thread', 'ALPHA,BRAVO', `${sameThread.word},${newThread.word}`);
    }
    if (wants('c')) {
      const code = (extra, w) => ask('What is the code word of this turn? Answer with that one word.', extra).then((r) => ({ ...r, word: word(r.answer, w) }));
      const t1 = await code({ instructions: 'The code word of this turn is FOXTROT.' }, ['FOXTROT', 'GOLF']);
      const t2 = await code({ session: t1.sessionId, instructions: 'The code word of this turn is GOLF.' }, ['FOXTROT', 'GOLF']);
      record('c', 'instructions FOXTROT then GOLF in one thread', 'FOXTROT,GOLF', `${t1.word},${t2.word}`);
    }

    // (d) the tool list is read once, when the profile is served; a re-serve fixes it. (g) rides along: `/reload-mcp` does nothing.
    if (wants('d') || wants('g')) {
      await hermes('restart');
      await sleep(5_000);
      await probeTools(); // lists the first tool once, so the profile has surely read the list
      standIn.addTool('probe_two');
      const lists = standIn.state.lists;
      const stale = await probeTools();
      const staleLists = standIn.state.lists - lists;
      if (wants('g')) {
        await ask('/reload-mcp');
        const afterCommand = await probeTools();
        record('g', '/reload-mcp as input: tools still the old list, no new tools/list', 'probe_one,0', `${afterCommand},${standIn.state.lists - lists}`);
      }
      if (wants('d')) {
        record('d', 'two tools on the server, no push: a fresh session lists, tools/list calls since', 'probe_one,0', `${stale},${staleLists}`);
        await hermes('restart');
        await sleep(5_000);
        record('d', 'after `gateway restart` of the profile', 'probe_one,probe_two', await probeTools());
      }
    }

    // (e) the push: session id + listChanged true + the GET stream; (f) .env and the token are read when the profile is served.
    if (wants('e') || wants('f')) {
      await standIn.close();
      standIn = await startStandIn({ tokens: ['token-1', 'token-2'], push: true });
      standIn.addTool('probe_two');
      writeFiles({ soul: readFileSync(join(dir, 'SOUL.md'), 'utf8'), mcpToken: 'token-1' }); // the new stand-in has a new port: the address is read at serve time too
      await hermes('restart');
      await sleep(6_000);
      const oldThread = await ask('Hello. Answer with the one word READY.');
      record('e', 'the stand-in gives a session id and opens the stream: streams Hermes opened', '1', String(standIn.state.streamsOpened));
      standIn.addTool('probe_three');
      const lists = standIn.state.lists;
      standIn.pushChange();
      await sleep(3_000);
      record('e', 'one list_changed: Hermes calls tools/list again, within 3 s', 'true', String(standIn.state.lists > lists));
      record('e', 'old thread, tools after the push (no restart)', 'probe_one,probe_three,probe_two', await probeTools({ session: oldThread.sessionId }));
      record('e', 'new thread, tools after the push', 'probe_one,probe_three,probe_two', await probeTools());

      if (wants('f')) {
        writeFiles({ soul: readFileSync(join(dir, 'SOUL.md'), 'utf8'), mcpToken: 'token-2' });
        standIn.pushChange();
        await sleep(3_000);
        const withoutRestart = standIn.state.lastToken;
        await hermes('restart');
        await sleep(6_000);
        record('f', 'MANYTHREADS_MCP_TOKEN changed in .env: token seen before / after a re-serve', `${shortHash('token-1')}>${shortHash('token-2')}`, `${withoutRestart}>${standIn.state.lastToken}`);
      }
    }
  } catch (e) {
    console.error(`the probe could not finish: ${e.message}`);
    await cleanup();
    return 2;
  } finally {
    await cleanup();
  }

  console.log(`\nrow | what | Hermes 0.21.5 | now\n${rows.map((r) => `(${r.row}) | ${r.what} | ${r.expected} | ${r.observed}${r.ok ? '' : '  <-- differs'}`).join('\n')}`);
  const differ = rows.filter((r) => !r.ok).length;
  console.log(differ === 0 ? '\nsame as v0.21.5: the table in docs/plugins/runtime-hermes.md still holds' : `\n${differ} row(s) differ: read the row, then update the table and the code that relies on it`);
  return differ === 0 ? 0 : 1;
}
