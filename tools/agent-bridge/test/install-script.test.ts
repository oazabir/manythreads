import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The installer's first checks (P26 review L4, L5): the site address must be https (the key and the code travel to it), and that is looked at before anything else on the
// machine. Only the REFUSALS are run here: a run that gets past them would install a service on this machine.

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'install', 'bridge.sh'), 'utf8');
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-sh-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(site: string, args: string[]): { status: number | null; out: string } {
  const file = join(dir, 'bridge.sh');
  writeFileSync(file, script.replaceAll('@@SITE@@', site).replaceAll('@@BUNDLE_SHA256@@', 'a'.repeat(64)).replaceAll('@@BRIDGE_VERSION@@', '1.0.0'));
  const res = spawnSync('bash', [file, ...args], { encoding: 'utf8', timeout: 20_000 });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const CODE = `mte_${'0'.repeat(40)}`;

describe('bridge.sh', () => {
  it('is valid bash, and --help only prints (it does nothing to the machine)', () => {
    const help = run('https://site.example', ['--help']);
    expect(help.status).toBe(0);
    expect(help.out).toContain('--code-file');
    expect(spawnSync('bash', ['-n', join(dir, 'bridge.sh')], { encoding: 'utf8' }).status).toBe(0);
  });

  it('opens the publisher\'s socket to the team users (P26-19 proof 4): their group is the unit\'s group, the publisher keeps its own group for the team homes, and the table names it', () => {
    expect(script).toMatch(/PUBLISH_GROUP=mt-publish/);
    expect(script).toMatch(/\nGroup=\$PUBLISH_GROUP\nSupplementaryGroups=\$PUB_USER\n/);
    expect(script).toMatch(/publishClientsGroup: e\.CFG_PUBLISH_GROUP/);
    expect(script).toMatch(/usermod -a -G "\$PUBLISH_GROUP" "\$tu"/);
    // the uninstall takes the group and any drop-in away with the rest
    expect(script).toMatch(/groupdel mt-publish/);
    expect(script).toMatch(/rm -rf \/etc\/systemd\/system\/manythreads-publisher\.service\.d/);
  });

  it('keeps the bridge running when the kernel kills one bot command for memory (P31-04): OOMPolicy=continue in the bridge\'s unit, once', () => {
    const unit = script.slice(script.indexOf('cat >"$UNIT_FILE" <<EOF'), script.indexOf('cat >"$PUB_UNIT_FILE" <<EOF'));
    expect(unit).toMatch(/\nOOMPolicy=continue\n/);
    expect(unit).toMatch(/\nRestart=always\n/);
    expect(script.match(/^OOMPolicy=/gm)).toHaveLength(1);
  });

  it('keeps Codex\'s sign-in folder the bridge user\'s alone (P31-01): no group, no setgid at any --update, and the helper\'s table names the bridge user', () => {
    expect(script).not.toMatch(/chown -hR "\$SVC_USER:\$AGENTS_GROUP"[^\n]*auth\/codex/);
    expect(script).not.toMatch(/find [^\n]*auth\/codex[^\n]*2770/);
    expect(script).toMatch(/bridgeUser: e\.CFG_BRIDGE_USER/);
    expect(script).toMatch(/CFG_BRIDGE_USER="\$SVC_USER"/);
    expect(script).toMatch(/move_codex_main_copy "\$DATA" "\$SVC_USER" "\$UNIT"/);
    expect(script).toMatch(/for c in sudo visudo setpriv flock timeout useradd/);
  });

  it('moves an old shared Codex folder once: only auth.json stays, 0700 and 0600, a link is not followed, and a second --update keeps what Codex wrote since', () => {
    const fn = /\nmove_codex_main_copy\(\) \{\n[\s\S]*?\n\}\n/.exec(script)?.[0];
    expect(fn).toBeDefined();
    const data = mkdtempSync(join(tmpdir(), 'codex-move-'));
    const main = join(data, 'auth', 'codex');
    const sh = (body: string) =>
      spawnSync('bash', ['-c', `set -euo pipefail\nsay() { printf '%s\\n' "$*"; }\nsystemctl() { echo "systemctl $*" >> "${data}/systemctl.log"; return 0; }\nchown() { :; }\n${fn}\n${body}`], { encoding: 'utf8' });
    try {
      execFileSync('bash', ['-c', `mkdir -p "${main}/sessions/2026" "${main}/tmp/arg0-linux" && echo sign-in > "${main}/auth.json" && echo t > "${main}/sessions/2026/r.jsonl" && echo s > "${main}/state_5.sqlite" && echo secret > "${data}/outside" && ln -s "${data}/outside" "${main}/linked" && chmod 2770 "${main}" && chmod 0660 "${main}/auth.json"`]);
      const first = sh(`move_codex_main_copy "${data}" "$(id -un)" manythreads-bridge.service`);
      expect(first.stderr).toBe('');
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('the teams\' old Codex sessions there were removed');
      expect(readFileSync(join(data, 'systemctl.log'), 'utf8')).toContain('systemctl stop manythreads-bridge.service');
      expect(spawnSync('ls', ['-A', main], { encoding: 'utf8' }).stdout.trim()).toBe('auth.json');
      expect(readFileSync(join(main, 'auth.json'), 'utf8')).toBe('sign-in\n');
      expect(readFileSync(join(data, 'outside'), 'utf8')).toBe('secret\n');
      const mode = (p: string): number => Number(execFileSync('stat', ['-c', '%a', p], { encoding: 'utf8' }).trim()) ;
      expect(mode(main)).toBe(700);
      expect(mode(join(main, 'auth.json'))).toBe(600);
      expect(mode(join(data, 'auth', '.locks'))).toBe(700);
      // what the sign-in's own Codex writes there later is not removed by the next --update
      writeFileSync(join(main, 'installation_id'), 'x');
      const second = sh(`move_codex_main_copy "${data}" "$(id -un)" manythreads-bridge.service`);
      expect(second.status).toBe(0);
      expect(second.stdout).not.toContain('removed');
      expect(existsSync(join(main, 'installation_id'))).toBe(true);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('allows full access by default for Claude Code and Codex (P35-01); --no-full-access refuses it and is remembered; the old --allow-full-access is accepted and ignored', () => {
    // the config writer, run on its own with the installer's variables
    const end = script.indexOf("' >\"$ETC/config.json.new\"");
    const at = script.lastIndexOf('"$node" -e \'\n', end);
    expect(at).toBeGreaterThan(-1);
    const body = script.slice(script.indexOf("'", at) + 1, end);
    const write = (full: string) => {
      const env = { ...process.env, CFG_DATA: '/var/lib/x', CFG_WANT_CLAUDE: '1', CFG_WANT_CODEX: '1', CFG_FULL: full, CFG_CLAUDE_ACP: '/a/claude-acp', CFG_CODEX_ACP: '/a/codex-acp', CFG_HELPER: '/h' };
      return JSON.parse(execFileSync(process.execPath, ['-e', body], { env, encoding: 'utf8' })) as { server: { agents: Record<string, { fullAccess?: string }>; teamUsers: unknown } };
    };
    const on = write('1');
    expect(on.server.agents['claude']?.fullAccess).toBe('allowed');
    expect(on.server.agents['codex']?.fullAccess).toBe('allowed');
    expect(on.server.teamUsers).toBeDefined();
    const off = write('0');
    expect(off.server.agents['claude']?.fullAccess).toBeUndefined();
    expect(off.server.agents['codex']?.fullAccess).toBeUndefined();
    // the flags: allowed unless refused, now or at an earlier install (a file, so an --update without the flag never widens a machine that said no)
    expect(script).toMatch(/local mode='' code='' code_file='' allow_full=1 /);
    expect(script).toMatch(/--no-full-access\) no_full=1 ;;/);
    expect(script).toMatch(/--allow-full-access\) old_full_flag=1 ;;/);
    expect(script).toMatch(/>"\$ETC\/no-full-access"/);
    expect(script).toMatch(/if \[ -e "\$ETC\/no-full-access" \]; then\n\s+allow_full=0/);
    expect(run('https://site.example', ['--help']).out).toContain('--no-full-access');
    // an update that widens the machine says so in one line, and a plain uninstall keeps the refusal (only --purge removes it)
    expect(script).toContain('Full access for Claude Code and Codex is now allowed on this machine (the default since 2026-11-20); rerun with --no-full-access to refuse it.');
    expect(script).toMatch(/\[ "\$mode" = update \] && \[ "\$allow_full" -eq 1 \] && \[ -f "\$ETC\/config.json" \] && ! grep -q '"fullAccess": "allowed"'/);
    const uninstall = script.slice(script.indexOf('uninstall_all() {'));
    expect(uninstall).not.toMatch(/rm -rf "\$PREFIX" "\$ETC"/);
    expect(uninstall).toMatch(/find "\$ETC" -mindepth 1 -maxdepth 1 ! -name no-full-access -exec rm -rf \{\} \+/);
    expect(uninstall).toMatch(/if \[ "\$purge" -eq 1 \]; then\n\s+rm -rf "\$ETC"/);
    expect(run('https://site.example', ['--allow-full-access']).out).not.toContain('unknown option');
  });

  it('refuses a site address that is not https, for every way in, before it looks at the machine', () => {
    for (const args of [['--enrol', CODE], ['--update'], ['--uninstall'], ['--code-file', join(dir, 'nothing')]]) {
      const r = run('http://site.example', args);
      expect(r.status, args.join(' ')).not.toBe(0);
      expect(r.out).toContain('not https');
      // it never got as far as the machine checks, which would name root or systemd
      expect(r.out).not.toMatch(/as root|systemd/);
    }
  });

  it('refuses a copy that has no site address, and any other scheme', () => {
    for (const site of ['', 'ftp://site.example', 'site.example', '@@SITE@@']) {
      const r = run(site, ['--enrol', CODE]);
      expect(r.status, site).not.toBe(0);
      expect(r.out).toMatch(/no site address|not https/);
    }
  });

  it('takes the code from a file or the keyboard and warns about one on the command line', () => {
    // the words are in the script the user reads
    expect(script).toContain('--code-file');
    expect(script).toContain('with ps until the script ends');
    expect(script).toContain('/dev/tty');
  });

  it('never installs Hermes: it only finds it, and --hermes-bin names where it is (owner decision 2026-11-16)', () => {
    expect(script).not.toMatch(/nousresearch|HERMES_INSTALLER_SHA256|install_hermes|hermes-agent\./);
    expect(run('https://site.example', ['--help']).out).toContain('--hermes-bin');
    // an option with no value is refused while the words are read, before anything on the machine is looked at
    const r = run('https://site.example', ['--update', '--hermes-bin']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('--hermes-bin needs the path');
    expect(r.out).not.toMatch(/as root|systemd/);
    // the three report lines and the one plain sentence with the fix
    expect(script).toContain('Hermes: found at');
    expect(script).toContain('Hermes: not found');
    expect(script).toContain('Hermes: found but not usable');
    expect(script).toContain('install Hermes system-wide, for example under /opt/hermes, or pass --hermes-bin <path>');
  });

  it('reads and removes the key where the bridge keeps it after a rotation, not only the installer\'s copy', () => {
    expect(script).toMatch(/live_key_file\(\)/);
    expect(script).toContain('rm -f "$DATA/state/key"');
  });

  it('--ca-sha256 is a documented option and its value is checked before the machine is looked at', () => {
    expect(run('https://site.example', ['--help']).out).toContain('--ca-sha256');
    const r = run('https://site.example', ['--update', '--ca-sha256']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('--ca-sha256 needs');
  });
});

// The pinning step, run on its own against a real self-signed site: right hash keeps the certificate, any other hash stops with nothing kept.
describe('pin_site_certificate', () => {
  let server: Server;
  let port = 0;
  let leafSha = '';
  let certDir: string;
  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'pin-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'k.pem'), '-out', join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const pem = readFileSync(join(certDir, 'c.pem'), 'utf8');
    const der = Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64');
    leafSha = createHash('sha256').update(der).digest('hex');
    server = createServer({ key: readFileSync(join(certDir, 'k.pem')), cert: pem }, (_q, s) => s.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(certDir, { recursive: true, force: true });
  });

  // asynchronous: the TLS site is in this very process, and a blocking call would stop it from answering
  const pin = (hash: string, out: string): Promise<{ status: number | null; out: string }> => {
    const fn = /^pin_site_certificate\(\) \{[\s\S]*?^\}$/m.exec(script)?.[0] ?? '';
    const prelude = 'say() { printf "%s\\n" "$*"; }\ndie() { printf "error: %s\\n" "$*" >&2; exit 1; }\n';
    return new Promise((resolve) => {
      execFile('bash', ['-c', `${prelude}${fn}\npin_site_certificate "https://127.0.0.1:${port}" "$1" "$2"`, 'x', hash, out], { encoding: 'utf8', timeout: 20_000 }, (err, stdout, stderr) => {
        resolve({ status: err === null ? 0 : typeof err.code === 'number' ? err.code : 1, out: `${stdout}${stderr}` });
      });
    });
  };

  it('keeps the certificate when the hash is the site\'s (colons and capitals are fine)', async () => {
    const out = join(dir, 'pinned-ok.pem');
    const r = await pin(leafSha.toUpperCase().replace(/(..)(?=.)/g, '$1:'), out);
    expect(r.out).toContain('matches');
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(join(certDir, 'c.pem'), 'utf8'));
  });

  it('refuses another hash and writes nothing', async () => {
    const out = join(dir, 'pinned-bad.pem');
    const r = await pin('0'.repeat(64), out);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('not the one this command was made for');
    expect(() => readFileSync(out)).toThrow();
  });

  it('refuses a value that is not 64 hex digits', async () => {
    const r = await pin('abc', join(dir, 'pinned-x.pem'));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('64 hex digits');
  });
});
