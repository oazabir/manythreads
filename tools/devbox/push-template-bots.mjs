// push-template-bots.mjs — commit the shipped template bots into a team's repo on the live site.
//
// The demo deployment seeded the Support and Marketing repositories directly, so the bots' BOT.md files are in git but the bots
// plugin (which loads a bot when a commit touches bots/<slug>/BOT.md) never saw a commit for them. Committing the same file again
// as a workspace admin is what makes the roster and the conversations real for the personas of those teams.
//
//   $env:DEMO_BASE='https://manythreads.kahf.to'
//   $env:DEMO_EMAIL='omar@kahf.example'; $env:DEMO_PASSWORD='...'
//   node tools/devbox/push-template-bots.mjs customer-support support-responder
//   node tools/devbox/push-template-bots.mjs marketing content-drafter
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const m = /^manythreads_csrf=([^;]*)/.exec(set);
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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [team, ...slugs] = process.argv.slice(2);
if (!team || slugs.length === 0) {
  console.error('usage: node push-template-bots.mjs <team> <bot-slug>...');
  process.exit(2);
}

const signin = await api('POST', '/api/auth/password/sign-in', { email: EMAIL, password: PASSWORD });
if (signin.status !== 200) {
  console.error(`signin failed: HTTP ${signin.status}`);
  process.exit(1);
}

for (const slug of slugs) {
  const path = join(repoRoot, 'templates', team, 'bots', slug, 'BOT.md');
  if (!existsSync(path)) {
    console.error(`no template bot at ${path}`);
    continue;
  }
  const content = readFileSync(path, 'utf8');
  const r = await api('POST', `/api/teams/${team}/repo/commit`, {
    message: `Add the ${slug} bot to the ${team} team`,
    changes: [{ op: 'put', path: `bots/${slug}/BOT.md`, content }],
  });
  console.log(`${team}/${slug}: HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`);
}
