// demo-journeys.mjs — headless driver for the live demo persona journeys.
// Runs on Windows against the public site; the browser screenshots come later.
//
//   $env:DEMO_BASE='https://manythreads.kahf.to'
//   $env:DEMO_EMAIL='omar@kahf.example'; $env:DEMO_PASSWORD='...'
//   node tools/devbox/demo-journeys.mjs signin
//   node tools/devbox/demo-journeys.mjs bots engineering
//   node tools/devbox/demo-journeys.mjs openconv engineering orchestrator
//   node tools/devbox/demo-journeys.mjs post <channelId> "@orchestrator plan the release checklist work"
//   node tools/devbox/demo-journeys.mjs waitreply <channelId> <rootId> [timeoutSec]
//
// One session per DEMO_EMAIL (cookies kept in memory for the process only).
const BASE = (process.env['DEMO_BASE'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const EMAIL = process.env['DEMO_EMAIL'] ?? '';
const PASSWORD = process.env['DEMO_PASSWORD'] ?? '';
if (!EMAIL || !PASSWORD) {
  console.error('DEMO_EMAIL and DEMO_PASSWORD must be set');
  process.exit(2);
}

let cookies = [];
let csrf = null;
const store = (res) => {
  for (const set of res.headers.getSetCookie()) {
    cookies.push(set.split(';')[0]);
    const m = /^(?:__Host-)?manythreads_csrf=([^;]+)/.exec(set);
    if (m) csrf = decodeURIComponent(m[1]);
  }
};
const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookies.length > 0 ? { cookie: cookies.join('; ') } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  store(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
};
const show = (label, r) => {
  console.log(`--- ${label} [${r.status}]`);
  console.log(JSON.stringify(r.json, null, 2)?.slice(0, 4000));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cmds = {
  async signin() {
    const r = await api('POST', '/api/auth/password/sign-in', { email: EMAIL, password: PASSWORD });
    show('signin', r);
  },
  async bots(team) {
    await cmds.signinSilent();
    show('bots', await api('GET', `/api/teams/${team}/bots`));
  },
  async channels(team) {
    await cmds.signinSilent();
    show('channels', await api('GET', `/api/teams/${team}/channels`));
  },
  async openconv(team, bot) {
    await cmds.signinSilent();
    const r = await api('POST', `/api/teams/${team}/bots/${bot}/conversation`);
    show('openconv', r);
  },
  async post(channelId, ...words) {
    await cmds.signinSilent();
    const r = await api('POST', `/api/channels/${channelId}/messages`, {
      channelId,
      body: words.join(' '),
      threadRootId: null,
    });
    show('post', r);
  },
  async thread(channelId, rootId) {
    await cmds.signinSilent();
    show('thread', await api('GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`));
  },
  // Poll a thread until a bot-authored message appears (the run's reply).
  async waitreply(channelId, rootId, timeoutSec = '600') {
    await cmds.signinSilent();
    const deadline = Date.now() + Number(timeoutSec) * 1000;
    for (;;) {
      const r = await api('GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
      const items = r.json?.items ?? [];
      const bot = items.find((m) => m?.author?.kind === 'bot');
      if (bot) {
        console.log(`BOT REPLY after ${Math.round((Date.now() - (deadline - Number(timeoutSec) * 1000)) / 1000)}s:`);
        console.log(bot.body);
        return;
      }
      if (Date.now() > deadline) {
        console.error(`no bot reply within ${timeoutSec}s; last thread state:`);
        console.log(JSON.stringify(items.map((m) => ({ kind: m?.author?.kind, body: m?.body?.slice(0, 200) })), null, 2));
        process.exit(1);
      }
      await sleep(10000);
    }
  },
  async approvals(team, status = 'pending') {
    await cmds.signinSilent();
    show('approvals', await api('GET', `/api/teams/${team}/approvals?status=${status}`));
  },
  async approve(team, id) {
    await cmds.signinSilent();
    show('approve', await api('POST', `/api/teams/${team}/approvals/${id}/approve`, { note: 'demo: approved by the lead' }));
  },
  async deny(team, id) {
    await cmds.signinSilent();
    show('deny', await api('POST', `/api/teams/${team}/approvals/${id}/deny`, { note: 'demo: denied by the lead' }));
  },
  async retainlog(team) {
    await cmds.signinSilent();
    show('retainlog', await api('GET', `/api/teams/${team}/memory/retain-log?limit=20`));
  },
  // Commit local demo-bots/<slug>/{BOT.md,memory.md} to the team's repo (one commit).
  async pushbots(team) {
    await cmds.signinSilent();
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'demo-bots');
    const changes = [];
    for (const slug of readdirSync(dir)) {
      for (const file of ['BOT.md', 'memory.md']) {
        try {
          changes.push({ op: 'put', path: `bots/${slug}/${file}`, content: readFileSync(join(dir, slug, file), 'utf8') });
        } catch {
          /* slug without that file */
        }
      }
    }
    const r = await api('POST', `/api/teams/${team}/repo/commit`, {
      message: 'Demo personabots: orchestrator, coder, tester, brain, sentinel',
      changes,
    });
    show('pushbots', r);
  },
  async llmProviders() {
    await cmds.signinSilent();
    show('llm-providers', await api('GET', '/api/workspace/llm/providers'));
  },
  async llmAddProvider(name, kind, apiBase) {
    await cmds.signinSilent();
    show(
      'llm-add-provider',
      await api('POST', '/api/workspace/llm/providers', { name, kind, apiBase, enabled: true, local: true }),
    );
  },
  async llmAliases() {
    await cmds.signinSilent();
    show('llm-aliases', await api('GET', '/api/workspace/llm/aliases'));
  },
  async llmSetAlias(alias, model, providerId) {
    await cmds.signinSilent();
    show(
      'llm-set-alias',
      await api('PUT', `/api/workspace/llm/aliases/${alias}`, { model, providerId: providerId ?? null, fallbacks: [] }),
    );
  },
  async signinSilent() {
    const r = await api('POST', '/api/auth/password/sign-in', { email: EMAIL, password: PASSWORD });
    if (r.status !== 200) {
      console.error(`signin failed: HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 500)}`);
      process.exit(1);
    }
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || !(cmd in cmds)) {
  console.error(`usage: node demo-journeys.mjs <${Object.keys(cmds).filter((k) => k !== 'signinSilent').join('|')}> [...]`);
  process.exit(2);
}
await cmds[cmd](...args);
