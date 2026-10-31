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
// Env: DEMO_BASE (default https://manythreads.kahf.to), HERMES_HOME (/root/.hermes), HERMES_CONNECTION (host),
//      HERMES_SHELL_CWD (/srv/hostdev, else /root/manythreads) for bots whose capabilities.runtime holds `shell`.
import {
  readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, chmodSync, renameSync, rmSync, accessSync, copyFileSync, constants,
} from 'node:fs';
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
const teams = args.filter((a) => !a.startsWith('--'));
if (!EMAIL || !PASSWORD || teams.length === 0) {
  console.error('usage: DEMO_EMAIL=... DEMO_PASSWORD=... node provision-host-bots.mjs <team>... [--dry] [--force]');
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARKER = 'Written by tools/devbox/provision-host-bots.mjs';
const MANAGED = ['API_SERVER_KEY', 'MANYTHREADS_MCP_TOKEN', 'LITELLM_API_KEY'];
const MCP_URL = `${BASE}/mcp`;

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

/** Read `KEY=value` lines of an env file; quotes around a value are dropped. Values are never printed. */
function readEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const gatewayEnv = readEnv(join(HERMES_HOME, '.env'));
const API_SERVER_KEY = gatewayEnv['API_SERVER_KEY'] ?? '';
const LITELLM_API_KEY = gatewayEnv['LITELLM_API_KEY'] ?? '';
if (!API_SERVER_KEY || !LITELLM_API_KEY) {
  console.error(`${join(HERMES_HOME, '.env')} must hold API_SERVER_KEY and LITELLM_API_KEY`);
  process.exit(1);
}
const SHELL_CWD = process.env['HERMES_SHELL_CWD'] ?? (existsSync('/srv/hostdev') ? '/srv/hostdev' : repoRoot);

/** The front matter of a BOT.md (CRLF or LF): the text between the first two `---` lines, where it starts and ends, and its line ending. */
function split(md) {
  const m = /^---\r?\n([\s\S]*?\r?\n)---(\r?\n|$)/.exec(md);
  if (!m) throw new Error('BOT.md has no front matter');
  const start = m[0].indexOf('\n') + 1;
  return { front: m[1], start, end: start + m[1].length, eol: m[1].includes('\r\n') ? '\r\n' : '\n' };
}
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
/** The definition's `capabilities.runtime` list (what the bot's process may do: shell, files, git, browser, ...). */
function runtimeGrants(md) {
  const m = /^capabilities:\r?\n[\s\S]*?^ {2}runtime:[ \t]*\r?\n((?:[ \t]+-.*\r?\n)+)/m.exec(split(md).front);
  return m ? [...m[1].matchAll(/^\s*-\s*([A-Za-z0-9_.-]+)\s*$/gm)].map((x) => x[1]) : [];
}
const hasShell = (md) => runtimeGrants(md).includes('shell');

// The grant -> Hermes toolset mapping is the platform's own (packages/plugins/runtime-hermes/src/toolsets.ts, the same function the managed
// pod's gateway-profile.ts uses): imported here, not copied, so the host profiles can never drift from the pod's. Node strips the types.
const { hermesToolsets } = await import(pathToFileURL(join(repoRoot, 'packages', 'plugins', 'runtime-hermes', 'src', 'toolsets.ts')).href);
const quote = (list) => `[${list.map((t) => JSON.stringify(t)).join(', ')}]`;

function configText(md) {
  const cwd = hasShell(md) ? SHELL_CWD : repoRoot;
  const toolsets = hermesToolsets(runtimeGrants(md));
  return `# manythreads mode A: a bot served by this host's own Hermes gateway (api_server). ${MARKER}.
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
    url: "${MCP_URL}"
    headers:
      Authorization: "Bearer \${MANYTHREADS_MCP_TOKEN}"
    timeout: 120
    connect_timeout: 30
platform_toolsets:
  api_server: ${quote(toolsets.enabled)}
agent:
  disabled_toolsets: ${quote(toolsets.disabled)}
tools:
  tool_search:
    enabled: "off"
terminal:
  backend: "local"
  cwd: "${cwd}"
  timeout: 600
`;
}

/** The existing .env with the three managed keys set; every other line stays as it was. */
function mergeEnv(existing, values) {
  const lines = existing === null ? [] : existing.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const seen = new Set();
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (m && MANAGED.includes(m[1]) && !seen.has(m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    }
    return line;
  });
  for (const k of MANAGED) if (!seen.has(k)) out.push(`${k}=${values[k]}`);
  return `${out.join('\n')}\n`;
}

/** Replace a file through a temp file next to it and a rename, so a reader never sees half of it. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Does the MCP server accept this token? `initialize` works with no run open; HTTP 401 is a revoked or wrong token. The token travels in a header only. */
async function probeToken(token) {
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'provision-host-bots', version: '1' } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    await res.text().catch(() => '');
    if (res.status === 401) return 'unauthorized';
    return res.ok ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
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
const dirOf = (profile) => join(profilesRoot, profile);

/** What the profile and its token look like now, without changing anything: the token state is one of kept, kept-unverified, stale, none. */
async function inspectProfile(profile) {
  const dir = dirOf(profile);
  const exists = existsSync(dir);
  const token = exists ? (readEnv(join(dir, '.env'))['MANYTHREADS_MCP_TOKEN'] ?? '') : '';
  let state = 'none';
  if (token) {
    const cfg = existsSync(join(dir, 'config.yaml')) ? readFileSync(join(dir, 'config.yaml'), 'utf8') : '';
    const url = /^\s*url:\s*"?([^"\s]+)"?/m.exec(cfg)?.[1];
    if (url && url !== MCP_URL) state = 'stale';
    else {
      const p = await probeToken(token);
      state = p === 'ok' ? 'kept' : p === 'unknown' ? 'kept-unverified' : 'stale';
    }
  }
  return { dir, exists, token, state };
}

/**
 * Make the profile right for one bot. Returns { token, files } words for the summary; throws when the profile cannot be written
 * (nothing was minted then) or when it could not be written after a mint (the mint is revoked first).
 */
async function ensureProfile(team, slug, profile, md) {
  const view = await inspectProfile(profile);
  mkdirSync(profilesRoot, { recursive: true, mode: 0o700 });
  // The place to write must be writable BEFORE a token is minted: a token is shown once.
  const build = view.exists ? view.dir : join(profilesRoot, `.tmp-${profile}-${process.pid}`);
  if (view.exists) {
    accessSync(view.dir, constants.W_OK);
    const envFile = join(view.dir, '.env');
    if (existsSync(envFile)) accessSync(envFile, constants.W_OK);
  } else {
    rmSync(build, { recursive: true, force: true });
    mkdirSync(build, { mode: 0o700 });
  }
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
    const cfgWanted = configText(md);
    let files;
    if (!view.exists) {
      writeAtomic(join(build, 'config.yaml'), cfgWanted);
      writeAtomic(join(build, '.env'), mergeEnv(null, values));
      renameSync(build, view.dir);
      files = 'created';
    } else {
      const cfgFile = join(view.dir, 'config.yaml');
      const cfgNow = existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null;
      let cfgWord = 'unchanged';
      if (cfgNow === null || (cfgNow.includes(MARKER) && cfgNow !== cfgWanted)) {
        writeAtomic(cfgFile, cfgWanted);
        cfgWord = 'config updated';
      } else if (cfgNow !== cfgWanted && !cfgNow.includes(MARKER)) {
        if (force) {
          copyFileSync(cfgFile, `${cfgFile}.bak`);
          chmodSync(`${cfgFile}.bak`, 0o600);
          writeAtomic(cfgFile, cfgWanted);
          cfgWord = 'config replaced (.bak kept)';
        } else cfgWord = 'config hand-edited, kept';
      }
      const envFile = join(view.dir, '.env');
      const envNow = existsSync(envFile) ? readFileSync(envFile, 'utf8') : null;
      const envWanted = mergeEnv(envNow, values);
      if (envNow !== envWanted) {
        writeAtomic(envFile, envWanted); // last: the token only lands once the config is in place
        cfgWord = cfgWord === 'unchanged' ? 'env updated' : `${cfgWord}, env updated`;
      }
      files = cfgWord;
    }
    return { tokenWord, files };
  } catch (e) {
    if (!view.exists) rmSync(build, { recursive: true, force: true }); // a half-built new directory only
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
  const slugs = readdirSync(templateDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const conns = await api('GET', `/api/teams/${team}/hermes/connections`);
  const conn = conns.json?.items?.find((c) => c.name === CONNECTION);
  if (!conn) throw new Error(`no Hermes connection named "${CONNECTION}"`);
  console.log(`\n== ${team}: ${slugs.length} bot(s), connection ${CONNECTION}`);

  // Plan: what the repo needs, per bot. One broken file fails that bot only.
  const infos = [];
  for (const slug of slugs) {
    const info = { team, slug, profile: `mt-${team}-${slug}`, placement: 'ok', token: '-', files: '-', test: '-', changes: [], isNew: false, failed: null };
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
      r = await api('POST', `/api/teams/${team}/hermes/connections/${conn.id}/test`, { profile: info.profile });
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

for (const team of teams) {
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
