// provision-host-bots.mjs — put every bot of a live team on the Hermes gateway that runs on this host ("mode A").
//
// For one team (its slug is also the name of its template under templates/) this
//   1. writes the profile `$HERMES_HOME/profiles/mt-<team>-<bot>/` (config.yaml, .env; dir 0700, files 0600) of every bot that is already
//      loaded and active, and mints a bot token only when the profile holds none that the MCP server accepts (see below),
//   2. adds the template bots the team's repo lacks (evals first, then BOT.md, as proposals applied in the same step) and sets every bot's
//      `placement:` to the team's Hermes connection (default `host`) with the profile `mt-<team>-<bot>`,
//   3. waits until the bots plugin shows each placement it expects (connection AND profile, not just "some placement"),
//   4. writes the profiles of the bots that were just added (a bot has to exist before a token can be minted for it), then tests every
//      profile through the connection.
// Order: for a bot that already exists the profile is written BEFORE its placement is committed, so the gateway never receives a run for
// a profile that is not there. A new bot has no runs yet, so it is added first and its profile follows.
// A bot's definition (BOT.md body) travels with each run as `instructions`, so the profile needs no SOUL.md text.
//
// Safe to re-run. `--dry` prints the plan and touches nothing (no commit, no token, no file). Secrets are read from files and never printed.
//   * A profile directory is built as `.tmp-<profile>-<pid>` (a name the gateway does not serve) and renamed into place; for an existing
//     profile config.yaml is replaced first and .env last, each through a temp file and a rename.
//   * config.yaml turns the bot's `capabilities.runtime` into Hermes toolsets (`platform_toolsets.api_server`, `agent.disabled_toolsets`) with the
//     platform's own mapping (toolsets.ts): a bot without `shell` has no terminal, one without `files` no file tools, one with no grant only `todo`.
//   * .env is merged: only API_SERVER_KEY, MANYTHREADS_MCP_TOKEN and LITELLM_API_KEY are touched, every other line stays.
//   * config.yaml is rewritten only when it carries this script's "Written by" header; a hand-edited one is left alone unless --force
//     (the old file is kept as config.yaml.bak).
//   * A kept token is probed at the MCP server (initialize with the token as Bearer; HTTP 401 means revoked or wrong) and replaced when it
//     fails, or when the profile's config.yaml points at another MCP url. A mint whose files cannot be written is revoked again (the
//     route can only turn off ALL live tokens of the bot) and the bot is reported FAILED.
//
//   DEMO_EMAIL=... DEMO_PASSWORD=... node tools/devbox/provision-host-bots.mjs engineering customer-support marketing [--dry] [--force]
//   DEMO_EMAIL=... DEMO_PASSWORD=... node tools/devbox/provision-host-bots.mjs --workspace-brain [engineering] [--brain-profile mt-brain] [--dry]
//      the workspace Brain (P20-LV): it belongs to no team, so it is not in any team's template; this writes its ONE host profile and mints its token
//      (an admin signs in; the mint goes through any team's bots route, here the first team named or `engineering`). The profile name is the default runner's
//      profile rule with {bot} = brain, or --brain-profile. Needs a default Hermes-gateway runner open to the teams (Admin > Bot runners), else no run is ever sent.
//   node tools/devbox/provision-host-bots.mjs --reserve engineering [--dry]   serve the team's profiles again (no login; assumes a multiplexing host gateway; see below)
// Env: DEMO_BASE (default https://manythreads.kahf.to), HERMES_HOME (/root/.hermes), HERMES_CONNECTION (host),
//      HERMES_SHELL_CWD (/srv/hostdev, else /root/manythreads) for bots whose capabilities.runtime holds `shell`.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE = (process.env['DEMO_BASE'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const EMAIL = process.env['DEMO_EMAIL'] ?? '';
const PASSWORD = process.env['DEMO_PASSWORD'] ?? '';
const HERMES_HOME = process.env['HERMES_HOME'] ?? '/root/.hermes';
const CONNECTION = process.env['HERMES_CONNECTION'] ?? 'host';
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const force = args.includes('--force');
const brainProfileFlag = args.indexOf('--brain-profile');
const brainProfileName = brainProfileFlag >= 0 ? (args[brainProfileFlag + 1] ?? '') : '';
const workspaceBrain = args.includes('--workspace-brain');
const teams = args.filter((a, i) => !a.startsWith('--') && !(brainProfileFlag >= 0 && i === brainProfileFlag + 1));

// The host profile of a team's bot: one name, used by the provisioning below and by --reserve.
const profileOf = (team, slug) => `mt-${team}-${slug}`;

// --reserve (PLAN P14-22): serve a profile again, for a host Hermes that did not take the tools push (an older Hermes, or a stream cut by a proxy). It is
// `hermes -p <profile> gateway restart`: under a multiplexing gateway that unserves and serves that one profile through the gateway's control socket
// (about two seconds; a run that is mid-answer finishes; no other profile is touched). It ASSUMES the host gateway multiplexes profiles: it refuses a profile
// that `hermes gateway list` does not show as "served by the default multiplexer" (a restart of any other kind would restart a whole gateway).
// Needs no login. Each name is an exact profile (`mt-engineering-engineer`) or a team slug: the profiles of the bots in `templates/<team>/bots/`, by the same
// naming as the provisioning (`mt-<team>-<bot>`), never by a name prefix (team `eng` must not catch `mt-eng-ops-*`). A bot a team added that is not in its
// template is named by its exact profile. `--dry` prints what it would do. Env: HERMES_HOME, HERMES_BIN (default `hermes`).
if (args.includes('--reserve')) {
  const { execFileSync } = await import('node:child_process');
  const home = process.env['HERMES_HOME'] ?? '/root/.hermes';
  const bin = process.env['HERMES_BIN'] ?? 'hermes';
  const hermesEnv = { ...process.env, HERMES_HOME: home };
  const root = join(home, 'profiles');
  const present = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]{0,60}$/.test(e.name)).map((e) => e.name) : [];
  const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const teamProfiles = (team) => {
    const dir = join(repoDir, 'templates', team, 'bots');
    return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => profileOf(team, d.name)) : [];
  };
  const wanted = [...new Set(teams.flatMap((name) => (present.includes(name) ? [name] : teamProfiles(name).filter((p) => present.includes(p)))))];
  if (teams.length === 0 || wanted.length === 0) {
    console.error(`usage: node provision-host-bots.mjs --reserve <profile|team>... [--dry]   (no profile found under ${root} for: ${teams.join(' ') || 'nothing named'})`);
    process.exit(2);
  }
  let listing = '';
  try {
    listing = execFileSync(bin, ['gateway', 'list'], { env: hermesEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  } catch (e) {
    console.error(`cannot run \`${bin} gateway list\`: ${String(e.stderr ?? e.message).slice(0, 200)}`);
    process.exit(2);
  }
  const multiplexed = new Set(listing.split('\n').flatMap((line) => (/served by the default multiplexer/.test(line) ? [line.replace(/^[^A-Za-z0-9]+/, '').split(/\s+/)[0]] : [])));
  let bad = 0;
  for (const profile of wanted) {
    if (!multiplexed.has(profile)) {
      bad += 1;
      console.error(`REFUSED ${profile}: \`${bin} gateway list\` does not show it as "served by the default multiplexer" (--reserve assumes a multiplexing host gateway)`);
      continue;
    }
    if (args.includes('--dry')) {
      console.log(`would run: ${bin} -p ${profile} gateway restart`);
      continue;
    }
    try {
      execFileSync(bin, ['-p', profile, 'gateway', 'restart'], { env: hermesEnv, stdio: 'pipe', timeout: 60_000 });
      console.log(`served again: ${profile}`);
    } catch (e) {
      bad += 1;
      console.error(`FAILED ${profile}: ${String(e.stderr ?? e.message).slice(0, 200)}`);
    }
  }
  process.exit(bad === 0 ? 0 : 1);
}

if (!EMAIL || !PASSWORD || (teams.length === 0 && !workspaceBrain)) {
  console.error('usage: DEMO_EMAIL=... DEMO_PASSWORD=... node provision-host-bots.mjs <team>... [--dry] [--force]   |   ... --workspace-brain [team] [--brain-profile NAME] [--dry]   |   node provision-host-bots.mjs --reserve <profile|team>... [--dry]');
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MCP_URL = `${BASE}/mcp`;

// The profile-writing code (what config.yaml and .env say, how a directory is replaced, how a kept token is checked) is shared with `admin brain-profile`
// (packages/server/src/cli/hermes-profile.ts), so the devbox and a Docker Compose install write the same profile.
const {
  readEnvFile, splitBotMd, runtimeGrants, hasShell, profileConfigText, inspectProfile: inspectProfileAt, prepareProfileDir, discardProfileDir, writeProfileFiles,
} = await import(pathToFileURL(join(repoRoot, 'packages', 'server', 'src', 'cli', 'hermes-profile.ts')).href);

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
    json = { _raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
};
const blob = async (team, path) => {
  const r = await api('GET', `/api/teams/${team}/repo/blob?path=${encodeURIComponent(path)}`);
  return r.status === 200 ? r.json : null;
};

const gatewayEnv = readEnvFile(join(HERMES_HOME, '.env'));
const API_SERVER_KEY = gatewayEnv['API_SERVER_KEY'] ?? '';
const LITELLM_API_KEY = gatewayEnv['LITELLM_API_KEY'] ?? '';
if (!API_SERVER_KEY || !LITELLM_API_KEY) {
  console.error(`${join(HERMES_HOME, '.env')} must hold API_SERVER_KEY and LITELLM_API_KEY`);
  process.exit(1);
}
const SHELL_CWD = process.env['HERMES_SHELL_CWD'] ?? (existsSync('/srv/hostdev') ? '/srv/hostdev' : repoRoot);

const split = splitBotMd;
const PLACEMENT = /^placement:[ \t]*\r?\n(?:[ \t]+.*\r?\n)+/m;
const PLACEMENT_KEY = /^placement:/m;
const placementBlock = (profile, eol) => ['placement:', '  gateway:', `    connection: ${CONNECTION}`, `    profile: ${profile}`, ''].join(eol);
/** BOT.md with the host placement: an existing block is replaced, otherwise one goes in before the closing `---`; the rest stays byte for byte. */
function withPlacement(md, profile) {
  const { front, start, end, eol } = split(md);
  const block = placementBlock(profile, eol);
  let next;
  if (PLACEMENT.test(front)) next = front.replace(PLACEMENT, () => block);
  else if (PLACEMENT_KEY.test(front)) throw new Error('"placement:" is in the front matter in a shape this script does not edit (inline value?); fix it by hand');
  else next = front + block;
  return md.slice(0, start) + next + md.slice(end);
}
// The grant -> Hermes toolset mapping is the platform's own (packages/plugins/runtime-hermes/src/toolsets.ts, the same function the managed
// pod's gateway-profile.ts uses): imported here, not copied, so the host profiles can never drift from the pod's. Node strips the types.
const { hermesToolsets } = await import(pathToFileURL(join(repoRoot, 'packages', 'plugins', 'runtime-hermes', 'src', 'toolsets.ts')).href);

function configText(md) {
  return profileConfigText({
    mcpUrl: MCP_URL,
    llmBaseUrl: 'https://litellm-hetzner.kahf.to/v1',
    cwd: hasShell(md) ? SHELL_CWD : repoRoot,
    toolsets: hermesToolsets(runtimeGrants(md)),
  });
}

/** A write that may hit the 10-a-minute limit of the pairing routes: wait and retry. */
async function withRetry(fn) {
  for (let i = 0; i < 8; i++) {
    const r = await fn();
    if (r.status !== 429) return r;
    await sleep(15_000);
  }
  return fn();
}

const profilesRoot = join(HERMES_HOME, 'profiles');
const inspectProfile = (profile) => inspectProfileAt(profilesRoot, profile, MCP_URL);

/**
 * Make the profile right for one bot. Returns { token, files } words for the summary; throws when the profile cannot be written
 * (nothing was minted then) or when it could not be written after a mint (the mint is revoked first).
 */
async function ensureProfile(team, slug, profile, md) {
  const view = await inspectProfile(profile);
  // The place to write must be writable BEFORE a token is minted: a token is shown once.
  const build = prepareProfileDir(profilesRoot, profile, view);
  let token = view.state === 'kept' || view.state === 'kept-unverified' ? view.token : '';
  let tokenWord = view.state === 'kept-unverified' ? 'kept (not checked)' : view.state;
  let minted = false;
  try {
    if (!token) {
      const r = await withRetry(() => api('POST', `/api/teams/${team}/bots/${slug}/pairing-tokens`, {}));
      token = r.status === 201 ? (r.json?.token ?? '') : '';
      if (!token) throw new Error(`token mint failed: HTTP ${r.status}`);
      minted = true;
      tokenWord = view.state === 'stale' ? 'minted (old one refused)' : 'minted';
    }
    const values = { API_SERVER_KEY, MANYTHREADS_MCP_TOKEN: token, LITELLM_API_KEY };
    const files = writeProfileFiles({ profile, view, build, config: configText(md), values, force });
    return { tokenWord, files };
  } catch (e) {
    discardProfileDir(build, view); // a half-built new directory only
    if (minted) {
      const r = await api('DELETE', `/api/teams/${team}/bots/${slug}/pairing-tokens`);
      throw new Error(`${e.message}; the new token was ${r.status === 200 ? 'revoked' : `NOT revoked (HTTP ${r.status}), revoke it on the bot's page`}`);
    }
    throw e;
  }
}

const signin = await api('POST', '/api/auth/password/sign-in', { email: EMAIL, password: PASSWORD });
if (signin.status !== 200) {
  console.error(`sign-in failed: HTTP ${signin.status}`);
  process.exit(1);
}

const rows = [];
let problems = 0;
const fail = (info, why) => {
  info.failed = why;
  problems += 1;
  console.error(`  ${info.slug}: FAILED: ${why}`);
};

async function doTeam(team) {
  const templateDir = join(repoRoot, 'templates', team, 'bots');
  if (!existsSync(templateDir)) throw new Error(`no template at ${templateDir}`);
  // The team Brain is retired: the one workspace Brain answers in every team (`--workspace-brain`), so no team gets a `brain` bot or a `mt-<team>-brain` profile.
  const slugs = readdirSync(templateDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'brain').map((d) => d.name).sort();
  const conns = await api('GET', `/api/teams/${team}/hermes/connections`);
  let conn = conns.json?.items?.find((c) => c.name === CONNECTION);
  // Since the runner catalog (P19-02) the place may be a runner an admin made available to the team instead of a connection of the team.
  let runner = null;
  if (!conn) {
    const runners = await api('GET', '/api/admin/bot-runners');
    runner = runners.json?.items?.find((r) => r.name === CONNECTION && r.enabled && (r.allTeams || r.teams.some((t) => t.slug === team))) ?? null;
    if (!runner) throw new Error(`no Hermes connection or runner named "${CONNECTION}" for this team`);
  }
  console.log(`\n== ${team}: ${slugs.length} bot(s), ${conn ? 'connection' : 'runner'} ${CONNECTION}`);

  // Plan: what the repo needs, per bot. One broken file fails that bot only.
  const infos = [];
  for (const slug of slugs) {
    const info = { team, slug, profile: profileOf(team, slug), placement: 'ok', token: '-', files: '-', test: '-', changes: [], isNew: false, failed: null };
    infos.push(info);
    try {
      const path = `bots/${slug}/BOT.md`;
      const current = await blob(team, path);
      // A seeded stand-in ("Placeholder definition for ...") has no capabilities at all, so its bot could never post its own reply: it is replaced by the template.
      const templateFile = join(templateDir, slug, 'BOT.md');
      const standIn = current !== null && current !== undefined && current.content.includes('Placeholder definition for') && existsSync(templateFile);
      const source = current && !standIn ? current.content : readFileSync(templateFile, 'utf8');
      info.md = withPlacement(source, info.profile);
      if (!current) {
        info.isNew = true;
        info.placement = 'added';
        // MISTAKES P7-08 / P7-01: the eval set goes in before BOT.md, so the BOT.md commit finds it.
        const evals = join(templateDir, slug, 'evals');
        if (existsSync(evals)) {
          for (const f of readdirSync(evals)) {
            const p = `bots/${slug}/evals/${f}`;
            const have = await blob(team, p);
            info.changes.push({ op: 'put', path: p, content: readFileSync(join(evals, f), 'utf8'), baseBlobSha: have ? have.blobSha : null });
          }
        }
        info.changes.push({ op: 'put', path, content: info.md, baseBlobSha: null });
      } else if (current.content !== info.md) {
        info.placement = 'set';
        info.changes.push({ op: 'put', path, content: info.md, baseBlobSha: current.blobSha });
      }
    } catch (e) {
      fail(info, e.message);
    }
  }

  if (dry) {
    for (const info of infos) {
      if (info.failed) continue;
      for (const c of info.changes) console.log(`  would put ${c.path}`);
      const v = await inspectProfile(info.profile);
      console.log(`  ${info.profile}: ${v.exists ? 'profile exists' : 'would create profile'}, token ${v.state === 'kept' || v.state === 'kept-unverified' ? 'kept' : v.state === 'stale' ? 'refused/stale, would mint' : 'would mint'}, cwd ${hasShell(info.md) ? SHELL_CWD : repoRoot}`);
      info.token = v.state === 'none' ? 'would mint' : v.state === 'stale' ? 'would re-mint' : 'kept';
      info.test = 'skipped (dry)';
    }
    rows.push(...infos);
    return;
  }

  const provision = async (info) => {
    try {
      const r = await ensureProfile(team, info.slug, info.profile, info.md);
      info.token = r.tokenWord;
      info.files = r.files;
      console.log(`  ${info.profile}: profile ${r.files}, token ${r.tokenWord}`);
    } catch (e) {
      fail(info, e.message);
    }
  };
  const loadedNow = async () => Object.fromEntries(((await api('GET', `/api/teams/${team}/bots`)).json?.bots ?? []).map((b) => [b.slug, b]));

  // A: bots that exist already get their profile before their placement is committed (a bot that is not active gets nothing).
  const before = await loadedNow();
  for (const info of infos.filter((i) => !i.failed && !i.isNew)) {
    if (before[info.slug]?.status !== 'active') fail(info, `bot is not loaded and active (${before[info.slug]?.status ?? 'missing'}); nothing written`);
    else await provision(info);
  }

  // B: commit (evals before BOT.md for a new bot; a bot whose profile failed keeps its old placement).
  for (const info of infos.filter((i) => !i.failed)) {
    for (const c of info.changes) {
      const r = await api('POST', `/api/teams/${team}/proposals`, {
        path: c.path, op: c.op, content: c.content, baseBlobSha: c.baseBlobSha, title: `Place ${info.slug} on the host Hermes gateway`, applyNow: true,
      });
      console.log(`  put ${c.path}: HTTP ${r.status}`);
      if (r.status !== 201) {
        fail(info, `commit of ${c.path}: HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
        break;
      }
    }
  }

  // C: wait until each bot shows the placement we expect (connection and profile).
  const live = infos.filter((i) => !i.failed);
  const matches = (b, info) => b?.status === 'active' && b.placement?.gateway?.connection === CONNECTION && b.placement.gateway.profile === info.profile;
  const deadline = Date.now() + 120_000;
  let loaded = {};
  for (;;) {
    loaded = await loadedNow();
    if (live.every((i) => matches(loaded[i.slug], i)) || Date.now() > deadline) break;
    await sleep(2_000);
  }
  for (const info of live) {
    if (!matches(loaded[info.slug], info)) {
      const b = loaded[info.slug];
      fail(info, `placement not loaded after 120 s (bot ${b?.status ?? 'missing'}${b?.invalid ? `, invalid: ${JSON.stringify(b.invalid).slice(0, 150)}` : ''})`);
      info.placement = `NOT LOADED`;
    }
  }

  // D: profiles of the bots just added.
  for (const info of infos.filter((i) => !i.failed && i.isNew)) await provision(info);

  // E: test every profile through the connection.
  for (const info of infos.filter((i) => !i.failed)) {
    let r = { status: 0, json: null };
    for (let i = 0; i < 8; i++) {
      r = conn
        ? await api('POST', `/api/teams/${team}/hermes/connections/${conn.id}/test`, { profile: info.profile })
        : await api('POST', `/api/admin/bot-runners/${runner.id}/test`, { profile: info.profile });
      if (r.status === 200 && r.json?.ok) break;
      await sleep(r.status === 429 ? 15_000 : 3_000); // the test route has a per-minute limit
    }
    const ok = r.status === 200 && r.json?.ok;
    info.test = ok ? 'ok' : `failed (HTTP ${r.status}${typeof r.json?.error === 'string' ? `: ${r.json.error.slice(0, 120)}` : ''})`;
    if (!ok) problems += 1;
    console.log(`  test ${info.profile}: ${info.test}`);
  }
  for (const info of infos) if (info.failed) info.test = 'skipped';
  rows.push(...infos);
}

/**
 * The workspace Brain: one host profile, one token. No BOT.md is committed (the Brain's definition is the platform's, not a team repo's) and no placement is set in it:
 * the default runner decides where it runs, so the profile has to be named the way that runner's rule names it.
 */
async function doWorkspaceBrain() {
  const via = teams[0] ?? 'engineering';
  const runners = await api('GET', '/api/admin/bot-runners');
  const items = runners.json?.items ?? [];
  const def = items.find((r) => r.isDefault) ?? null;
  const ruleProfile = def?.profileRule ? def.profileRule.replace('{bot}', 'brain') : null;
  const profile = brainProfileName || ruleProfile || 'mt-brain';
  console.log(`\n== workspace Brain: profile ${profile}, token minted through team ${via}`);
  if (!def) console.error('  WARNING: no default runner is set (Admin > Bot runners): the Brain has no place to run until an admin makes a Hermes gateway runner the default.');
  else if (def.kind !== 'hermes_gateway') console.error(`  WARNING: the default runner "${def.name}" is a ${def.kind}, not a Hermes gateway; this host profile is only used by a gateway runner.`);
  else if (!def.enabled) console.error(`  WARNING: the default runner "${def.name}" is switched off.`);
  if (def && ruleProfile && profile !== ruleProfile) console.error(`  WARNING: the default runner names a bot's profile "${ruleProfile}"; this writes "${profile}", so a run will not find it.`);
  const info = { team: '(workspace)', slug: 'brain', profile, placement: 'by the default runner', token: '-', files: '-', test: '-', failed: null };
  const md = readFileSync(join(repoRoot, 'templates', '_workspace', 'bots', 'brain', 'BOT.md'), 'utf8');
  info.md = md;
  if (dry) {
    const v = await inspectProfile(profile);
    console.log(`  ${profile}: ${v.exists ? 'profile exists' : 'would create profile'}, token ${v.state === 'kept' || v.state === 'kept-unverified' ? 'kept' : v.state === 'stale' ? 'refused/stale, would mint' : 'would mint'}`);
    info.token = v.state === 'none' ? 'would mint' : v.state === 'stale' ? 'would re-mint' : 'kept';
    info.test = 'skipped (dry)';
    rows.push(info);
    return;
  }
  try {
    const r = await ensureProfile(via, 'brain', profile, md);
    info.token = r.tokenWord;
    info.files = r.files;
    console.log(`  ${profile}: profile ${r.files}, token ${r.tokenWord}`);
  } catch (e) {
    fail(info, e.message);
  }
  if (!info.failed && def && def.kind === 'hermes_gateway') {
    let t = { status: 0, json: null };
    for (let i = 0; i < 8; i++) {
      t = await api('POST', `/api/admin/bot-runners/${def.id}/test`, { profile });
      if (t.status === 200 && t.json?.ok) break;
      await sleep(t.status === 429 ? 15_000 : 3_000);
    }
    const ok = t.status === 200 && t.json?.ok;
    info.test = ok ? 'ok' : `failed (HTTP ${t.status}${typeof t.json?.error === 'string' ? `: ${t.json.error.slice(0, 120)}` : ''})`;
    if (!ok) problems += 1;
    console.log(`  test ${profile}: ${info.test}`);
  }
  rows.push(info);
}

if (workspaceBrain) {
  try {
    await doWorkspaceBrain();
  } catch (e) {
    console.error(`workspace Brain: ${e.message}`);
    problems += 1;
  }
}

for (const team of workspaceBrain ? [] : teams) { // with --workspace-brain a named team only carries the token mint
  try {
    await doTeam(team);
  } catch (e) {
    console.error(`${team}: ${e.message}`);
    problems += 1;
  }
}

console.log('\nteam | bot | profile | placement | token | profile files | test');
for (const r of rows) console.log(`${r.team} | ${r.slug} | ${r.profile} | ${r.failed ? `FAILED: ${r.failed.slice(0, 80)}` : r.placement} | ${r.token} | ${r.files} | ${r.test}`);
console.log(problems === 0 ? '\nall good' : `\n${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
