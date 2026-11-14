// place-engineering-bots.mjs — move the Engineering chain's bots to a runner (or back to the team's managed pod) in one go.
//
// A bot's placement is the `placement:` block of its `BOT.md` in the team's repository; it applies to every thread of the bot, so a delivery on another agent means
// moving all chain bots first (P25-16). This reads each chain bot's file, replaces only the `placement:` block and commits the change as a proposal applied at once.
//
//   DEMO_BASE=<site address> DEMO_EMAIL=... DEMO_PASSWORD=... node tools/devbox/place-engineering-bots.mjs <team> <runner-name | managed> [--dry]
//
// `managed` writes back the template's own placement (`gateway: connection: managed`); any other word is a runner's short name (`placement.runs_on`).

const BASE = (process.env['DEMO_BASE'] ?? '').replace(/\/+$/, '');
const EMAIL = process.env['DEMO_EMAIL'] ?? '';
const PASSWORD = process.env['DEMO_PASSWORD'] ?? '';
const [team, target, flag] = process.argv.slice(2);
if (!BASE || !EMAIL || !PASSWORD || !team || !target) {
  console.error('usage: DEMO_EMAIL=... DEMO_PASSWORD=... node place-engineering-bots.mjs <team> <runner-name|managed> [--dry]');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(target)) {
  console.error('the runner name is lower case letters, digits and "-"');
  process.exit(2);
}
const dry = flag === '--dry';
const CHAIN = ['engineer', 'plan-reviewer', 'coder', 'code-reviewer', 'tester', 'committer', 'deployer', 'web-smoke-tester'];
const PLACEMENT = /^placement:\n(?:[ \t]+.*\n)+/m;
const wanted = target === 'managed' ? 'placement:\n  gateway:\n    connection: managed\n' : `placement:\n  runs_on: ${target}\n`;

let cookies = [];
let csrf = null;
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
  for (const set of res.headers.getSetCookie()) {
    cookies.push(set.split(';')[0]);
    const m = /^(?:__Host-)?manythreads_csrf=([^;]+)/.exec(set);
    if (m) csrf = decodeURIComponent(m[1]);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
};

const signin = await api('POST', '/api/auth/password/sign-in', { email: EMAIL, password: PASSWORD });
if (signin.status !== 200) {
  console.error(`sign-in failed: HTTP ${signin.status}`);
  process.exit(1);
}
let failed = 0;
for (const slug of CHAIN) {
  const path = `bots/${slug}/BOT.md`;
  const r = await api('GET', `/api/teams/${team}/repo/blob?path=${encodeURIComponent(path)}`);
  if (r.status !== 200) {
    console.log(`  ${path}: not found (HTTP ${r.status})`);
    continue;
  }
  const current = r.json.content;
  const was = PLACEMENT.exec(current)?.[0];
  if (!was) {
    console.log(`  ${path}: no placement block, left alone`);
    continue;
  }
  if (was === wanted) {
    console.log(`  ${path}: already placed`);
    continue;
  }
  console.log(`  ${path}: ${was.replace(/\n/g, ' ').trim()}  ->  ${wanted.replace(/\n/g, ' ').trim()}`);
  if (dry) continue;
  const put = await api('POST', `/api/teams/${team}/proposals`, {
    path,
    op: 'put',
    content: current.replace(PLACEMENT, () => wanted),
    baseBlobSha: r.json.blobSha,
    title: `Place ${slug} on ${target} (P25-16)`.slice(0, 200),
    applyNow: true,
  });
  console.log(`    HTTP ${put.status}${put.status === 201 ? '' : ` ${JSON.stringify(put.json)?.slice(0, 300)}`}`);
  if (put.status !== 201) failed += 1;
}
process.exit(failed > 0 ? 1 : 0);
