// run.mjs — drive the Engineering team to build a feature end to end on a manythreads site (docs/engineering/self-build.md).
//
//   node tools/self-build/run.mjs start <request-file> [--channel dev]   post "@engineer <request>" in the channel; prints the thread root id
//   node tools/self-build/run.mjs watch <rootId> [--minutes 90]           follow the thread, print each new message (who + first lines), stop on quiet or time
//   node tools/self-build/run.mjs shot <url> <out.png>                    screenshot a page with Playwright (the proof kept for each stage)
//
// Sign-in: MT_BASE (the site's address, required) and the person named by MT_USER (required: the <NAME> prefix of its two entries) in ~/manythreads.passwords.env
// (<NAME>_EMAIL, <NAME>_PASSWORD). The values are read here and never printed. Output goes to MT_OUT (default ./self-build-out, git-ignored by the caller).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.MT_BASE ?? '').replace(/\/+$/, '');
if (!BASE) { console.error('set MT_BASE to the address of the site to drive'); process.exit(2); }
const USER = process.env.MT_USER ?? '';
if (!USER) { console.error('set MT_USER to the <NAME> prefix of the person in ~/manythreads.passwords.env'); process.exit(2); }
const TEAM = process.env.MT_TEAM ?? 'engineering';
const OUT = process.env.MT_OUT ?? 'self-build-out';

function secrets() {
  const rows = readFileSync(join(homedir(), 'manythreads.passwords.env'), 'utf8').split('\n');
  const env = {};
  for (const l of rows) {
    const m = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

async function login() {
  const env = secrets();
  const jar = new Map();
  const take = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };
  const api = async (method, path, body) => {
    const csrf = jar.get('__Host-manythreads_csrf') ?? jar.get('manythreads_csrf');
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    take(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
    return { status: res.status, json };
  };
  const r = await api('POST', '/api/auth/password/sign-in', { email: env[`${USER}_EMAIL`], password: env[`${USER}_PASSWORD`] });
  if (r.status !== 200) throw new Error(`sign-in failed: HTTP ${r.status}`);
  return api;
}

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

async function channelId(api, name) {
  const r = await api('GET', `/api/teams/${TEAM}/channels`);
  const all = (r.json?.groups ?? []).flatMap((g) => g.channels);
  const c = all.find((x) => x.name === name);
  if (!c) throw new Error(`no channel #${name} in ${TEAM}`);
  return c.id;
}

async function start(file) {
  const api = await login();
  const body = `@engineer ${readFileSync(file, 'utf8').trim()}`;
  const id = await channelId(api, flag('channel', 'dev'));
  const r = await api('POST', `/api/channels/${id}/messages`, { channelId: id, body, threadRootId: null });
  if (r.status !== 201) throw new Error(`post failed: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  console.log(JSON.stringify({ rootId: r.json.id, channelId: id }));
}

async function watch(rootId) {
  const api = await login();
  const deadline = Date.now() + Number(flag('minutes', '90')) * 60_000;
  const quietMs = Number(flag('quiet-minutes', '20')) * 60_000;
  const seen = new Set();
  const log = [];
  let lastNew = Date.now();
  while (Date.now() < deadline && Date.now() - lastNew < quietMs) {
    const r = await api('GET', `/api/threads/${rootId}?limit=200`);
    if (r.status !== 200) { console.log(`thread read: HTTP ${r.status}`); await new Promise((s) => setTimeout(s, 15_000)); continue; }
    const replies = [...(r.json.replies?.items ?? [])].reverse();
    for (const m of replies) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      lastNew = Date.now();
      log.push(m);
      const who = m.author?.name ?? m.author?.kind ?? '?';
      console.log(`[${m.createdAt}] ${who}: ${String(m.body).split('\n').slice(0, 4).join(' / ').slice(0, 400)}`);
    }
    await new Promise((s) => setTimeout(s, 20_000));
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `thread-${rootId}.json`), JSON.stringify(log, null, 2));
  console.log(`watch ended: ${log.length} replies saved to ${OUT}/thread-${rootId}.json`);
}

async function shot(url, out) {
  const { createRequire } = await import('node:module');
  const { chromium } = createRequire(new URL('../../e2e/package.json', import.meta.url))('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url, { waitUntil: 'networkidle' });
  mkdirSync(join(out, '..'), { recursive: true });
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log(`saved ${out}`);
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'start' && a) await start(a);
  else if (cmd === 'watch' && a) await watch(a);
  else if (cmd === 'shot' && a && b) await shot(a, b);
  else { console.error('usage: run.mjs start <file> | watch <rootId> | shot <url> <out.png>'); process.exit(2); }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
