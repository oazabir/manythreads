// The part of the Docker Compose test that a person does in the browser, done through the API (tools/compose-test/run.sh runs it after `admin init`):
//   1. sign in as the administrator `admin init` made;
//   2. give the workspace a model provider (the stand-in `fake-llm` of docker-compose.test.yml) and bind the aliases smart, fast and code to it;
//   3. open the workspace Brain's conversation, ask it a question the stand-in answers from its seeded memory facts, and wait for the reply to appear.
// Exit 0 only when the Brain's reply (a message written by the bot, not by the administrator) contains the expected text. Nothing secret is printed.
//
//   BASE=http://127.0.0.1:19700 EMAIL=... PASSWORD=... node tools/compose-test/drive.mjs [--no-provider] [--timeout 240]
const BASE = (process.env.BASE ?? '').replace(/\/+$/, '');
const EMAIL = process.env.EMAIL ?? '';
const PASSWORD = process.env.PASSWORD ?? '';
const PROVIDER_BASE = process.env.PROVIDER_BASE ?? 'http://fake-llm:4010/v1';
const QUESTION = process.env.QUESTION ?? 'Brain, what is the deploy command? Please recall it from memory.';
const EXPECT = new RegExp(process.env.EXPECT ?? 'pnpm ship:dev');
const args = process.argv.slice(2);
const timeoutS = Number(args[args.indexOf('--timeout') + 1] || 240) || 240;
if (!BASE || !EMAIL || !PASSWORD) {
  console.error('BASE, EMAIL and PASSWORD are required');
  process.exit(2);
}
const log = (m) => console.log(`drive: ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cookies = new Map();
let csrf = '';
async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  for (const set of res.headers.getSetCookie()) {
    const [pair = ''] = set.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value === '') cookies.delete(name);
    else cookies.set(name, value);
    if (/^(?:__Host-)?manythreads_csrf$/.test(name) && value !== '') csrf = decodeURIComponent(value);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}
const fail = (m) => {
  console.error(`drive: FAILED: ${m}`);
  process.exit(1);
};
const said = (r) => `HTTP ${r.status}${r.json?.error?.message ? `: ${String(r.json.error.message).slice(0, 160)}` : ''}`;

const signIn = await call('POST', '/api/auth/password/sign-in', { email: EMAIL, password: PASSWORD });
if (signIn.status !== 200) fail(`sign-in ${said(signIn)}`);
log('signed in');

// The web client is served by the same address.
const page = await fetch(`${BASE}/`);
const html = await page.text();
if (!page.ok || !html.includes('<div id="root"') && !html.includes('<script')) fail(`the app page is not served at / (HTTP ${page.status})`);
log(`the app page is served at / (HTTP ${page.status}, ${html.length} bytes)`);
const deep = await fetch(`${BASE}/t/anything/chat`);
if (!deep.ok) fail(`a deep link did not give the app page (HTTP ${deep.status})`);

if (!args.includes('--no-provider')) {
  const have = await call('GET', '/api/workspace/llm/providers');
  let provider = (have.json?.providers ?? []).find((p) => p.name === 'compose-test');
  if (!provider) {
    const made = await call('POST', '/api/workspace/llm/providers', { name: 'compose-test', kind: 'openai_compatible', apiKey: 'sk-compose-test-provider', apiBase: PROVIDER_BASE, local: true });
    if (made.status >= 300) fail(`provider ${said(made)}`);
    provider = made.json?.provider;
  }
  for (const alias of ['smart', 'fast', 'code']) {
    const put = await call('PUT', `/api/workspace/llm/aliases/${alias}`, { providerId: provider.id, model: 'fake-model' });
    if (put.status >= 300) fail(`alias ${alias} ${said(put)}`);
  }
  log('provider and aliases smart, fast, code set');
}

const teams = await call('GET', '/api/teams');
const team = (teams.json?.teams ?? [])[0]?.slug;
if (!team) fail('no team');
const conv = await call('POST', `/api/teams/${team}/bots/brain/conversation`, {});
if (conv.status >= 300 || !conv.json?.channelId) fail(`conversation ${said(conv)}`);
const channelId = conv.json.channelId;
log(`Brain conversation open in team ${team}`);

const deadline = Date.now() + timeoutS * 1000;
let attempt = 0;
while (Date.now() < deadline) {
  attempt += 1;
  const posted = await call('POST', `/api/channels/${channelId}/messages`, { channelId, threadRootId: null, body: QUESTION });
  if (posted.status >= 300) fail(`posting the question ${said(posted)}`);
  log(`question posted (try ${attempt})`);
  const until = Math.min(deadline, Date.now() + 90_000);
  while (Date.now() < until) {
    await sleep(3000);
    const list = await call('GET', `/api/channels/${channelId}/messages?limit=50`);
    const items = list.json?.items ?? [];
    const reply = items.find((m) => m.author?.kind === 'bot' && EXPECT.test(String(m.body ?? '')));
    if (reply) {
      log(`Brain answered after about ${Math.round((Date.now() - (deadline - timeoutS * 1000)) / 1000)} s: ${String(reply.body).split('\n').slice(0, 2).join(' / ').slice(0, 160)}`);
      process.exit(0);
    }
    const other = items.find((m) => m.author?.kind === 'bot');
    if (other) log(`a bot message arrived without the expected text: ${String(other.body).slice(0, 120).replace(/\n/g, ' / ')}`);
  }
}
{
  const list = await call('GET', `/api/channels/${channelId}/messages?limit=20`);
  for (const m of (list.json?.items ?? []).reverse()) log(`  message by ${m.author?.kind ?? '?'} ${m.author?.displayName ?? ''}: ${String(m.body ?? '').replace(/\n/g, ' / ').slice(0, 200)}`);
}
fail(`no reply that matches ${EXPECT} within ${timeoutS} seconds`);
