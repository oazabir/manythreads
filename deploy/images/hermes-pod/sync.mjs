// Turns the profile Secret (mounted at /in/profiles.json) into Hermes profile directories, once per call.
//   - new profile  -> write it; if the gateway is already up, `hermes -p <name> gateway run` attaches it (and its MCP servers) in ~2 s
//   - changed MCP/config/env -> rewrite it and `hermes -p <name> gateway restart` (a served profile keeps its old MCP connection otherwise)
//   - removed profile -> delete the directory (the gateway stops serving it within 30 s)
// Each bot also gets an ssh key pair here: the private half stays in this container (~/.ssh/keys), the public half goes to /keys for
// the workbench. Profile files may not carry a `terminal:` block of their own: it is replaced by the ssh backend pointing at the bot's
// Unix user in the workbench container.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HOME = process.env.HOME ?? '/home/node';
const PROFILES = join(HOME, '.hermes', 'profiles');
const IN = process.env.PROFILES_JSON ?? '/in/profiles.json';
const KEYS_OUT = process.env.KEYS_OUT ?? '/keys';
const STARTED = '/tmp/hermes-sync-started';
const MARKER = '.manythreads-profile';
const WORKBENCH_HOST = process.env.WORKBENCH_HOST ?? '127.0.0.1';
const WORKBENCH_PORT = Number(process.env.WORKBENCH_PORT ?? 2222);
const log = (m) => console.log(`sync: ${m}`);
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Drops a top-level `terminal:` block (the key line and every following indented or blank line). Linear, no regex backtracking. */
export function withoutTerminalBlock(yaml) {
  const out = [];
  let skipping = false;
  for (const line of yaml.split('\n')) {
    if (/^terminal:/.test(line)) { skipping = true; continue; }
    if (skipping && (line === '' || line.startsWith(' ') || line.startsWith('\t') || line.startsWith('#'))) continue;
    skipping = false;
    out.push(line);
  }
  return out.join('\n').replace(/\s+$/, '') + '\n';
}

export function terminalBlock(p, keyPath) {
  const j = (v) => JSON.stringify(v);
  return [
    'terminal:',
    '  backend: ssh',
    `  ssh_host: ${j(WORKBENCH_HOST)}`,
    `  ssh_port: ${WORKBENCH_PORT}`,
    `  ssh_user: ${j(p.user)}`,
    `  ssh_key: ${j(keyPath)}`,
    `  cwd: ${j(p.cwd)}`,
    '',
  ].join('\n');
}

// The profile's config names its variables MANYTHREADS_MCP_TOKEN / MANYTHREADS_LLM_KEY (the provider's secrets are called MCP_TOKEN / LLM_KEY).
const ENV_ALIASES = { MCP_TOKEN: 'MANYTHREADS_MCP_TOKEN', LLM_KEY: 'MANYTHREADS_LLM_KEY' };
function envFile(secrets) {
  const all = { ...secrets };
  for (const [from, to] of Object.entries(ENV_ALIASES)) if (from in all && !(to in all)) all[to] = all[from];
  return Object.entries(all)
    .filter(([k]) => /^[A-Z][A-Z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, '')}`)
    .join('\n') + '\n';
}

function ensureKey(user) {
  const priv = join(HOME, '.ssh', 'keys', user);
  if (!existsSync(priv)) {
    const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${user}@hermes-pod`, '-f', priv]);
    if (r.status !== 0) throw new Error(`ssh-keygen failed for ${user}`);
  }
  mkdirSync(KEYS_OUT, { recursive: true });
  copyFileSync(`${priv}.pub`, join(KEYS_OUT, `${user}.pub`));
  return priv;
}

function safeJoin(base, rel) {
  const p = resolve(base, rel);
  if (!p.startsWith(base + '/')) throw new Error(`path escapes the profile: ${rel}`);
  return p;
}

function hermes(profile, verb) {
  const r = spawnSync('hermes', ['-p', profile, 'gateway', verb], { encoding: 'utf8', timeout: 90_000 });
  if (r.status !== 0) { log(`hermes -p ${profile} gateway ${verb} failed: ${(r.stderr || r.stdout || '').slice(-300)}`); return false; }
  log(`hermes -p ${profile} gateway ${verb} ok`);
  return true;
}

export function syncOnce() {
  if (!existsSync(IN)) { log('no profile file yet'); return; }
  const doc = JSON.parse(readFileSync(IN, 'utf8'));
  const list = Array.isArray(doc.profiles) ? doc.profiles : [];
  const gatewayUp = existsSync(STARTED);
  const names = new Set();
  mkdirSync(PROFILES, { recursive: true });
  for (const p of list) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(p.profile) || !/^[a-z][a-z0-9-]{0,30}$/.test(p.user)) { log(`skip bad name ${p.profile}`); continue; }
    names.add(p.profile);
    const dir = join(PROFILES, p.profile);
    const isNew = !existsSync(join(dir, MARKER));
    const keyPath = ensureKey(p.user);
    const files = { ...p.files };
    files['config.yaml'] = withoutTerminalBlock(files['config.yaml'] ?? '') + terminalBlock(p, keyPath);
    files['.env'] = envFile(p.secrets ?? {});
    // restart-relevant: everything that Hermes reads only when a profile is served (config, env). Prompts and skills are re-read every turn.
    const hash = sha(files['config.yaml'] + '\0' + files['.env']);
    const hashFile = join(dir, '.manythreads-hash');
    const previous = existsSync(hashFile) ? readFileSync(hashFile, 'utf8') : '';
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const target = safeJoin(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target) && readFileSync(target, 'utf8') === content) continue;
      writeFileSync(target, content, { mode: 0o600 });
      chmodSync(target, 0o600);
    }
    writeFileSync(join(dir, MARKER), `${p.profile}\n`);
    if (!gatewayUp) { writeFileSync(hashFile, hash); continue; }
    if (isNew) { if (hermes(p.profile, 'run')) writeFileSync(hashFile, hash); }
    else if (hash !== previous) { if (hermes(p.profile, 'restart')) writeFileSync(hashFile, hash); }
  }
  for (const entry of readdirSync(PROFILES, { withFileTypes: true })) {
    if (!entry.isDirectory() || names.has(entry.name)) continue;
    if (existsSync(join(PROFILES, entry.name, MARKER))) { rmSync(join(PROFILES, entry.name), { recursive: true, force: true }); log(`removed ${entry.name}`); }
  }
  writeFileSync(STARTED, '1');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  try { syncOnce(); } catch (err) { log(`failed: ${err.message}`); process.exitCode = 1; }
}
