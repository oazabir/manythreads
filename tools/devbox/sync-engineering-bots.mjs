// sync-engineering-bots.mjs — bring a live team's bot copies up to the Engineering template, in one commit.
//
// A team's `bots/<slug>/BOT.md` files are copies made when the team was created; a template change never reaches them. This reads the
// team's copy of every template bot, keeps the team's own `placement:` block (its gateway connection and profile), puts the template's
// body and settings in, renames the old chain (orchestrator, reviewer, browser-tester) to engineer, code-reviewer and web-smoke-tester,
// and commits the lot as a workspace admin. TEAM.md follows the template too (its `dispatch` names the bot that answers first).
//
// TEMPLATE_PLACEMENT=1 keeps the template's placement (the team's managed Hermes pod) instead of the team's own.
//   DEMO_BASE=https://manythreads.kahf.to DEMO_EMAIL=... DEMO_PASSWORD=... node tools/devbox/sync-engineering-bots.mjs <team> [--dry]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env['DEMO_BASE'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const EMAIL = process.env['DEMO_EMAIL'] ?? '';
const PASSWORD = process.env['DEMO_PASSWORD'] ?? '';
const [team, flag] = process.argv.slice(2);
if (!EMAIL || !PASSWORD || !team) {
  console.error('usage: DEMO_EMAIL=... DEMO_PASSWORD=... node sync-engineering-bots.mjs <team> [--dry]');
  process.exit(2);
}
const dry = flag === '--dry';

/** Old slug -> new slug: the new bot starts from the old bot's placement, and the old files are deleted. */
const RENAMED = { orchestrator: 'engineer', reviewer: 'code-reviewer', 'browser-tester': 'web-smoke-tester' };

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
const blob = async (path) => {
  const r = await api('GET', `/api/teams/${team}/repo/blob?path=${encodeURIComponent(path)}`);
  return r.status === 200 ? r.json : null;
};

/** P7-01: bots/, TEAM.md, skills/ and routines/ take no direct commit; each change goes in as a proposal applied in the same step (one file each). */
async function applyAll(team, changes, message) {
  let failed = 0;
  for (const c of changes) {
    const r = await api('POST', `/api/teams/${team}/proposals`, {
      path: c.path,
      op: c.op,
      ...(c.op === 'put' ? { content: c.content } : {}),
      ...(c.baseBlobSha !== undefined ? { baseBlobSha: c.baseBlobSha } : {}),
      title: message.slice(0, 200),
      applyNow: true,
    });
    console.log(`  ${c.op} ${c.path}: HTTP ${r.status}${r.status === 201 ? '' : ` ${JSON.stringify(r.json)?.slice(0, 300)}`}`);
    if (r.status !== 201) failed += 1;
  }
  return failed;
}

const PLACEMENT = /^placement:\n(?:[ \t]+.*\n)+/m;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'engineering');

const signin = await api('POST', '/api/auth/password/sign-in', { email: EMAIL, password: PASSWORD });
if (signin.status !== 200) {
  console.error(`sign-in failed: HTTP ${signin.status}`);
  process.exit(1);
}

const changes = [];
const note = [];
const botDirs = readdirSync(join(root, 'bots'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const oldOf = Object.fromEntries(Object.entries(RENAMED).map(([o, n]) => [n, o]));

/** Only the chain moves; Brain, Alert triage and Standup relay keep the team's own copies. */
const CHAIN = new Set(['engineer', 'plan-reviewer', 'coder', 'code-reviewer', 'tester', 'committer', 'deployer', 'web-smoke-tester']);
for (const slug of botDirs.filter((d) => CHAIN.has(d))) {
  const dir = join(root, 'bots', slug);
  const files = [join('BOT.md')];
  if (existsSync(join(dir, 'evals'))) for (const f of readdirSync(join(dir, 'evals'))) files.push(join('evals', f));
  for (const rel of files) {
    const path = `bots/${slug}/${rel.split('\\').join('/')}`;
    let content = readFileSync(join(dir, rel), 'utf8');
    const current = await blob(path);
    if (rel === 'BOT.md') {
      // The team's own placement wins: the template ships the managed pod, a team may run on the host gateway or the Claude bridge.
      const source = current ?? (oldOf[slug] ? await blob(`bots/${oldOf[slug]}/BOT.md`) : null);
      const placement = source ? PLACEMENT.exec(source.content)?.[0] : undefined;
      if (placement && process.env['TEMPLATE_PLACEMENT'] !== '1') {
        const fixed = oldOf[slug] ? placement.split(`d-${oldOf[slug]}`).join(`d-${slug}`) : placement;
        content = content.replace(PLACEMENT, fixed);
      }
    }
    if (current && current.content === content) continue;
    changes.push({ op: 'put', path, content, ...(current ? { baseBlobSha: current.blobSha } : { baseBlobSha: null }) });
    note.push(`${current ? 'update' : 'add'} ${path}`);
  }
}
for (const old of Object.keys(RENAMED)) {
  for (const path of [`bots/${old}/BOT.md`, `bots/${old}/evals/${old}.yaml`]) {
    const current = await blob(path);
    if (current) {
      changes.push({ op: 'delete', path, baseBlobSha: current.blobSha });
      note.push(`delete ${path}`);
    }
  }
}
// TEAM.md: only the dispatch block and the chain's working agreement follow the template; the team's own name, roles and other lines stay.
const teamMd = await blob('TEAM.md');
if (teamMd) {
  const templateTeamMd = readFileSync(join(root, 'TEAM.md'), 'utf8');
  const DISPATCH = /^dispatch:\n(?:[ \t]+.*\n)+/m;
  const AGREEMENT = /^- A goal asked in a project channel[\s\S]*?(?=^- Production deploys)/m;
  let merged = teamMd.content;
  for (const re of [DISPATCH, AGREEMENT]) {
    const wanted = re.exec(templateTeamMd)?.[0];
    if (wanted && re.test(merged)) merged = merged.replace(re, () => wanted);
  }
  if (merged !== teamMd.content) {
    changes.push({ op: 'put', path: 'TEAM.md', content: merged, baseBlobSha: teamMd.blobSha });
    note.push('update TEAM.md');
  }
}

console.log(`${team}: ${changes.length} change(s)\n  ${note.join('\n  ')}`);
if (dry || changes.length === 0) process.exit(0);
const failed = await applyAll(
  team,
  changes,
  'Engineering chain: engineer, plan-reviewer, coder, code-reviewer, tester, committer, deployer, web-smoke-tester (synced from the template)',
);
process.exit(failed === 0 ? 0 : 1);
