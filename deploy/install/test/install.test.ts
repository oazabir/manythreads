import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { haveHelm } from '../../helm/test/chart.ts';

/**
 * P27-04 and P27-05: deploy/install/install.sh and deploy/install/manythreads. The functions are sourced (MANYTHREADS_INSTALL_SOURCE_ONLY) and run against stand-in
 * commands in a temp folder; nothing real is installed, no cluster is touched. Rendering the values file the installer writes through the real chart proves they fit.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const install = join(root, 'deploy/install/install.sh');
const host = join(root, 'deploy/install/manythreads');
const chart = join(root, 'deploy/helm/manythreads');
const haveJq = spawnSync('jq', ['--version']).status === 0;

let tmp = '';
let bin = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'install-sh-'));
  bin = join(tmp, 'bin');
  mkdirSync(bin);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const d = (c: string): string => `sha256:${c.repeat(64)}`;
const release = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  version: '0.27.0',
  commit: 'abc',
  createdAt: '2026-11-16T10:00:00.000Z',
  registry: 'ghcr.io/acme',
  images: Object.fromEntries(['server', 'web', 'postgres-cnpg', 'hermes-pod', 'workbench', 'claude-pod'].map((n, i) => [n, `ghcr.io/acme/manythreads-${n}@${d(String(i + 1))}`])),
  chart: { ref: 'oci://ghcr.io/acme/charts/manythreads', version: '0.27.0' },
  installSha256: 'a'.repeat(64),
  hostCommandSha256: 'b'.repeat(64),
  ...over,
});

function bash(script: string, env: Record<string, string> = {}, file = install) {
  const r = spawnSync('bash', ['-c', `source "${file}"\n${script}`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env['PATH']}`, HOME: tmp, MANYTHREADS_INSTALL_SOURCE_ONLY: '1', MANYTHREADS_HOST_SOURCE_ONLY: '1', MANYTHREADS_ETC: join(tmp, 'etc'), MANYTHREADS_INSTALL_LOG: join(tmp, 'install.log'), ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}
function runInstall(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [install, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env['PATH']}`, HOME: tmp, MANYTHREADS_ETC: join(tmp, 'etc'), MANYTHREADS_INSTALL_LOG: join(tmp, 'install.log'), MANYTHREADS_VAR: join(tmp, 'var'), ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('the choices of HTTPS (docs/plans/onboarding-journey.md §3.6)', () => {
  const plan = (...a: string[]) => bash(`plan_tls ${a.map((x) => `'${x}'`).join(' ')}`);
  it('a name that was given gets Let\'s Encrypt; no name and a public address the sslip.io name; neither a self-signed certificate on the address', () => {
    expect(plan('auto', 'team.example.com', '203.0.113.10', '10.0.0.5').out).toBe('letsencrypt team.example.com -');
    expect(plan('auto', '', '203.0.113.10', '10.0.0.5').out).toBe('letsencrypt 203-0-113-10.sslip.io -');
    expect(plan('auto', '', '', '10.0.0.5').out).toBe('selfsigned 10.0.0.5 -');
  });
  it('the flags decide when given: none, selfsigned, letsencrypt (needs a name or a public address), cloudflare (needs a name)', () => {
    expect(plan('none', '', '203.0.113.10', '10.0.0.5').out).toBe('none 203.0.113.10 -');
    expect(plan('selfsigned', 'box.lan', '203.0.113.10', '10.0.0.5').out).toBe('selfsigned box.lan -');
    expect(plan('letsencrypt', '', '', '10.0.0.5').code).toBe(3);
    expect(plan('cloudflare', '', '1.2.3.4', '10.0.0.5').code).toBe(2); // secret-scan:ignore test fixture addresses
    expect(plan('cloudflare', 'team.example.com', '', '10.0.0.5').out).toBe('cloudflare team.example.com -');
    expect(plan('bogus', '', '', '').code).toBe(4);
  });
  it('knows a public address from a private one', () => {
    const pub = (ip: string) => bash(`is_public_ipv4 '${ip}' && echo yes || echo no`).out;
    for (const ip of ['8.8.8.8', '203.0.113.10', '172.32.0.1', '100.63.0.1']) expect(pub(ip), ip).toBe('yes'); // secret-scan:ignore test fixture addresses
    for (const ip of ['10.0.0.5', '192.168.1.2', '172.16.0.1', '172.31.255.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '224.0.0.1', '256.1.1.1', 'abc', '']) expect(pub(ip), ip).toBe('no'); // secret-scan:ignore test fixture addresses
    expect(bash('sslip_name 203.0.113.10').out).toBe('203-0-113-10.sslip.io');
  });
});

describe('the checks', () => {
  it('memory: under 8 GB stops, 8 to 16 GB leaves the agent pods off, 16 GB or more is everything', () => {
    const cls = (mb: number) => bash(`memory_class ${mb}`).out;
    expect([cls(4096), cls(7000), cls(7800), cls(12000), cls(15600), cls(32000)]).toEqual(['too-small', 'too-small', 'small', 'small', 'full', 'full']);
  });
  it('disk: under 40 GB stops, under 80 GB warns', () => {
    const cls = (gb: number) => bash(`disk_class ${gb}`).out;
    expect([cls(39), cls(40), cls(79), cls(80)]).toEqual(['too-small', 'small', 'small', 'ok']);
  });
  it('check_machine names each problem in a plain line and fails only on errors', () => {
    stub('df', 'echo "Avail"; echo " 20G"');
    stub('nproc', 'echo 2');
    writeFileSync(join(tmp, 'mem4'), 'MemTotal:        4046000 kB\n');
    writeFileSync(join(tmp, 'mem8'), 'MemTotal:        8200000 kB\n');
    writeFileSync(join(tmp, 'mem16'), 'MemTotal:       16000000 kB\n');
    const bad = bash('check_machine', { MANYTHREADS_MEMINFO: join(tmp, 'mem4') });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('error: manythreads needs at least 8 GB of memory; this machine has 4 GB');
    expect(bad.out).toContain('error: manythreads needs at least 40 GB of free disk space; this machine has 20 GB free');
    expect(bad.out).toContain('warning: this machine has 2 CPU cores');
    stub('df', 'echo "Avail"; echo " 60G"');
    const warn = bash('check_machine', { MANYTHREADS_MEMINFO: join(tmp, 'mem8') });
    expect(warn.code).toBe(0);
    expect(warn.out).toContain('the agent pods (Claude Code and Codex in a pod) are left off');
    expect(warn.out).toContain('60 GB of disk is free; 80 GB or more is comfortable');
    stub('df', 'echo "Avail"; echo " 200G"');
    stub('nproc', 'echo 8');
    const fine = bash('check_machine', { MANYTHREADS_MEMINFO: join(tmp, 'mem16') });
    expect(fine.out.split('\n').filter((l) => /^(error|warning): (manythreads needs|this machine has|\d+ GB)/.test(l))).toEqual([]);
  });
  it('versions compare as numbers, and an equal one is not lower', () => {
    const lt = (a: string, b: string) => bash(`version_lt ${a} ${b} && echo yes || echo no`).out;
    expect([lt('0.27.0', '0.27.10'), lt('0.28.0', '0.27.10'), lt('0.27.0', '0.27.0'), lt('0.9.0', '0.10.0'), lt('1.0.0', '0.99.0')]).toEqual(['yes', 'no', 'no', 'yes', 'no']);
  });
});

describe.skipIf(!haveJq)('release.json as the installer reads it', () => {
  const problem = (r: Record<string, unknown>) => {
    const f = join(tmp, 'release.json');
    writeFileSync(f, JSON.stringify(r));
    return bash(`release_problem "${f}"`).out;
  };
  it('a good file has no problem; each missing piece is named', () => {
    expect(problem(release())).toBe('');
    expect(problem(release({ schema: 2 }))).toContain('unknown schema');
    expect(problem(release({ version: 'next' }))).toContain('no valid version');
    const images = release()['images'] as Record<string, string>;
    expect(problem(release({ images: { ...images, web: 'ghcr.io/acme/manythreads-web:latest' } }))).toContain('no digest for the image web');
    expect(problem(release({ installSha256: 'x' }))).toContain('SHA-256 of install.sh');
    expect(problem(release({ hostCommandSha256: undefined }))).toContain('manythreads command');
    expect(problem(release({ chart: { ref: 'https://x', version: '1.0.0' } }))).toContain('names no chart');
  });
});

describe.skipIf(!haveJq || !haveHelm)('the values file the installer writes fits the chart', () => {
  function renderWith(mode: string, host: string, extra: string, ips: string, claude: string, server = 'staging') {
    const rel = join(tmp, 'release.json');
    writeFileSync(rel, JSON.stringify(release()));
    const out = join(tmp, 'values.yaml');
    const w = bash(`write_values "${out}" "${rel}" "${mode}" "${host}" "${extra}" me@example.com ${server} ${claude} "${ips}"`);
    expect(w.code, w.err).toBe(0);
    const r = spawnSync('helm', ['template', 'manythreads', chart, '-n', 'manythreads', '-f', join(chart, 'values-install.yaml'), '-f', out, '--set', 'hermesPods.apiServer.cidr=10.0.2.15/32'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    return { yaml: readFileSync(out, 'utf8'), rendered: r.stdout };
  }
  it('Let\'s Encrypt on an sslip.io name: the images are the release\'s digests, the agent pod follows the memory', () => {
    const { yaml, rendered } = renderWith('letsencrypt', '203-0-113-10.sslip.io', '-', '', 'true');
    expect(yaml).toContain('domain: 203-0-113-10.sslip.io');
    expect(yaml).toContain(`image: ghcr.io/acme/manythreads-server@${d('1')}`);
    expect(rendered).toContain(`image: ghcr.io/acme/manythreads-server@${d('1')}`);
    expect(rendered).toContain(`ghcr.io/acme/manythreads-claude-pod@${d('6')}`);
    expect(rendered).toContain('acme-v02.api.letsencrypt.org'.replace('acme-v02', 'acme-staging-v02'));
    expect(rendered).not.toMatch(/image: manythreads\//);
  });
  it('a self-signed certificate on an address, with the machine\'s own address added', () => {
    const { rendered } = renderWith('selfsigned', '203.0.113.10', '-', '10.0.0.5', 'false');
    expect(rendered).toContain('kind: Certificate');
    expect(rendered).toContain('10.0.0.5');
    expect(rendered).not.toContain('manythreads-claude-pod@');
  });
  it('plain HTTP carries its public address; the production certificate is one word away', () => {
    expect(renderWith('none', '203.0.113.10', '-', '', 'false').yaml).toContain('publicUrl: http://203.0.113.10');
    expect(renderWith('letsencrypt', 'team.example.com', '-', '', 'false', 'production').rendered).toContain('https://acme-v02.api.letsencrypt.org/directory');
  });
  it('an upgrade moves only the image lines of the file', () => {
    const rel1 = join(tmp, 'r1.json');
    const rel2 = join(tmp, 'r2.json');
    writeFileSync(rel1, JSON.stringify(release()));
    const images2 = Object.fromEntries(Object.keys(release()['images'] as object).map((n, i) => [n, `ghcr.io/acme/manythreads-${n}@${d(String(i + 7 > 9 ? 9 : i + 7))}`]));
    writeFileSync(rel2, JSON.stringify(release({ version: '0.28.0', images: images2 })));
    const f = join(tmp, 'values.yaml');
    bash(`write_values "${f}" "${rel1}" letsencrypt team.example.com - me@example.com production true ""`);
    const before = readFileSync(f, 'utf8');
    const r = bash(`refresh_images "${f}" "${rel2}"`);
    expect(r.code, r.err).toBe(0);
    const after = readFileSync(f, 'utf8');
    expect(after).toContain(`image: ghcr.io/acme/manythreads-server@${d('7')}`);
    expect(after).toContain(`hermes: ghcr.io/acme/manythreads-hermes-pod@${d('9')}`);
    expect(after.replace(/@sha256:[0-9a-f]{64}/g, '').split('\n').filter((l) => !l.startsWith('#'))).toEqual(before.replace(/@sha256:[0-9a-f]{64}/g, '').split('\n').filter((l) => !l.startsWith('#')));
  });
});

describe('running it', () => {
  it('--print-plan prints the plan, needs no root, writes nothing and asks nothing', () => {
    const r = runInstall(['--print-plan', '--public-ip', '203.0.113.10', '--version', '0.27.0', '--release-url', 'https://example.org/release.json']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('address:       203-0-113-10.sslip.io   (HTTPS: letsencrypt)');
    expect(r.out).toMatch(/2\. (install k3s v1\.36\.5\+k3s1|k3s: the cluster that is here is used)/);
    expect(r.out).toContain('/etc/manythreads/values.yaml'.replace('/etc/manythreads', join(tmp, 'etc')));
    expect(existsSync(join(tmp, 'etc'))).toBe(false);
    expect(existsSync(join(tmp, 'install.log'))).toBe(false);
  });
  it('--print-plan with no address anywhere says self-signed', () => {
    stub('ip', 'echo "1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5 uid 0"'); // secret-scan:ignore test fixture addresses
    stub('curl', 'exit 22');
    const r = runInstall(['--print-plan', '--release-url', 'x']);
    expect(r.out).toContain('(HTTPS: selfsigned)');
  });
  it('refuses an unknown option, a bad --tls and a cloudflare install without its certificate', () => {
    expect(runInstall(['--wat']).err).toContain('unknown option: --wat');
    expect(runInstall(['--tls', 'maybe', '--print-plan']).err).toContain('--tls wants');
    expect(runInstall(['--tls', 'cloudflare', '--print-plan']).err).toContain('needs --domain');
    expect(runInstall(['--tls', 'cloudflare', '--domain', 'a.example.com', '--print-plan']).err).toContain('--origin-cert');
  });
  it.skipIf(!haveJq)('run again with the same release says "already installed", changes nothing and starts nothing; an older release is refused on --upgrade', () => {
    mkdirSync(join(tmp, 'etc'));
    writeFileSync(join(tmp, 'etc/install.env'), 'VERSION=0.28.0\nADDRESS=https://203-0-113-10.sslip.io\nRELEASE_URL=\n');
    writeFileSync(join(tmp, 'release.json'), JSON.stringify(release({ version: '0.28.0' })));
    writeFileSync(join(tmp, 'old.json'), JSON.stringify(release({ version: '0.27.0' })));
    for (const c of ['kubectl', 'helm', 'k3s']) stub(c, `echo "$0 $*" >>"${tmp}/calls.log"; exit 0`);
    const again = runInstall(['--release-url', join(tmp, 'release.json'), '--admin-email', 'me@example.com'], { MANYTHREADS_INSTALL_FOR_TESTS: '1', MANYTHREADS_HOST_COMMAND: join(tmp, 'none') });
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain('already installed (0.28.0)');
    expect(again.out).toContain('Open: https://203-0-113-10.sslip.io');
    const lower = runInstall(['--upgrade', '--release-url', join(tmp, 'old.json'), '--admin-email', 'me@example.com'], { MANYTHREADS_INSTALL_FOR_TESTS: '1' });
    expect(lower.code).toBe(1);
    expect(lower.err).toContain('older than the installed one (0.28.0)');
    expect(existsSync(join(tmp, 'calls.log'))).toBe(false);
  });
  it.skipIf(!haveJq)('a release that does not name a digest stops before anything is changed', () => {
    writeFileSync(join(tmp, 'bad.json'), JSON.stringify(release({ images: {} })));
    const r = runInstall(['--release-url', join(tmp, 'bad.json'), '--admin-email', 'me@example.com'], { MANYTHREADS_INSTALL_FOR_TESTS: '1' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('names no digest');
    expect(r.err).toContain('nothing was changed');
    expect(readdirSync(tmp).includes('etc')).toBe(false);
  });
  it('without a release address it says so', () => {
    const r = runInstall(['--admin-email', 'me@example.com'], { MANYTHREADS_INSTALL_FOR_TESTS: '1' });
    expect(r.err).toContain('--release-url');
  });
});

describe('the state file', () => {
  it('keeps one line per key, mode 0600, and reads it back', () => {
    const r = bash('state_put VERSION 0.27.0; state_put HOST a.example.com; state_put VERSION 0.28.0; state_get VERSION; state_get HOST; stat -c %a "$ETC/install.env"');
    expect(r.out.split('\n')).toEqual(['0.28.0', 'a.example.com', '600']);
    expect(readFileSync(join(tmp, 'etc/install.env'), 'utf8').match(/^VERSION=/gm)).toHaveLength(1);
  });
});

describe('the manythreads command', () => {
  const runHost = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [host, ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env['PATH']}`, HOME: tmp, MANYTHREADS_ETC: join(tmp, 'etc'), MANYTHREADS_VAR: join(tmp, 'var'), KUBECONFIG: join(tmp, 'kubeconfig'), ...env },
    });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const calls = (): string => (existsSync(join(tmp, 'calls.log')) ? readFileSync(join(tmp, 'calls.log'), 'utf8') : '');
  beforeEach(() => {
    mkdirSync(join(tmp, 'etc'));
    writeFileSync(join(tmp, 'etc/install.env'), 'VERSION=0.27.0\nHOST=203-0-113-10.sslip.io\nADDRESS=https://203-0-113-10.sslip.io\nTLS_MODE=letsencrypt\nADMIN_EMAIL=me@example.com\n');
    // kubectl: records the call; answers the secrets and the admin command like the cluster would
    stub(
      'kubectl',
      `
echo "kubectl $*" >>"${tmp}/calls.log"
args="$*"
case "$args" in
  *"get secret manythreads-first-admin -o jsonpath={.data.email}"*) printf 'me@example.com' | base64 -w0 ;;
  *"get secret manythreads-first-admin -o jsonpath={.data.password}"*) printf 'FIRSTPASSWORD24CHARSabcd' | base64 -w0 ;;
  *"get secret manythreads-server-secrets"*) printf 'THE-KMS-KEY' | base64 -w0 ;;
  *"admin password-status"*) echo "FIRST_PASSWORD=$FAKE_STATUS" ;;
  *"admin reset-password"*) echo "NEW_PASSWORD_EMAIL=me@example.com"; echo "NEW_PASSWORD=NEWPASSWORD24CHARSabcdef" ;;
esac
exit 0`,
    );
    stub('id', 'echo 0');
  });

  it('url and version read the state file; help lists the commands; an unknown one is refused', () => {
    expect(runHost(['url']).out).toBe('https://203-0-113-10.sslip.io');
    expect(runHost(['version']).out).toBe('manythreads 0.27.0');
    expect(runHost(['help']).out).toContain('manythreads admin-password');
    expect(runHost(['frobnicate']).code).toBe(1);
  });
  it('says so when manythreads is not installed here', () => {
    rmSync(join(tmp, 'etc/install.env'));
    expect(runHost(['status']).err).toContain('not installed');
  });
  it('admin-password shows the first password while it is still the one in use, and says "chose their own" after', () => {
    const pending = runHost(['admin-password'], { FAKE_STATUS: 'pending' });
    expect(pending.out).toContain('Password: FIRSTPASSWORD24CHARSabcd');
    const changed = runHost(['admin-password'], { FAKE_STATUS: 'changed' });
    expect(changed.out).toContain('chose their own password');
    expect(changed.out).not.toContain('FIRSTPASSWORD');
    expect(runHost(['admin-password'], { FAKE_STATUS: 'unknown' }).code).toBe(1);
  });
  it('reset-admin-password prints the new password once and keeps it in the Secret for admin-password', () => {
    const r = runHost(['reset-admin-password']);
    expect(r.out).toContain('Password: NEWPASSWORD24CHARSabcdef');
    expect(calls()).toContain('admin reset-password me@example.com --generate');
    expect(calls()).toContain('create secret generic manythreads-first-admin');
    expect(calls()).not.toContain('NEWPASSWORD24CHARSabcdef');
  });
  it('backup-key prints the key of the server\'s Secret', () => {
    expect(runHost(['backup-key']).out).toContain('THE-KMS-KEY');
  });
  it('set-domain refuses a bad name and a missing chart, and changes nothing', () => {
    expect(runHost(['set-domain', 'not a name']).err).toContain('give a name like');
    expect(runHost(['set-domain', 'team.example.com']).err).toContain('chart of this release is not kept');
    expect(existsSync(join(tmp, 'etc/domain.yaml'))).toBe(false);
  });
  it('set-domain tries a trial certificate, then the real one, keeps the old address working and updates the state', () => {
    mkdirSync(join(tmp, 'var/chart'), { recursive: true });
    writeFileSync(join(tmp, 'var/chart/values-install.yaml'), '');
    writeFileSync(join(tmp, 'etc/values.yaml'), '');
    stub('helm', `echo "helm $*" >>"${tmp}/calls.log"; cat "${tmp}/etc/domain.yaml" >>"${tmp}/domains.log"; exit 0`);
    // a stand-in for kubectl that says the certificate is Ready at once
    stub('kubectl', `echo "kubectl $*" >>"${tmp}/calls.log"; case "$*" in *certificate*) printf True ;; esac; exit 0`);
    stub('sleep', 'exit 0');
    const r = runHost(['set-domain', 'team.example.com']);
    expect(r.code, r.err).toBe(0);
    const domains = readFileSync(join(tmp, 'domains.log'), 'utf8');
    expect(domains.indexOf('server: staging')).toBeLessThan(domains.indexOf('server: production'));
    const final = readFileSync(join(tmp, 'etc/domain.yaml'), 'utf8');
    expect(final).toContain('domain: team.example.com');
    expect(final).toContain('extraDomains: [203-0-113-10.sslip.io]');
    expect(final).toContain('email: me@example.com');
    expect(readFileSync(join(tmp, 'etc/install.env'), 'utf8')).toContain('HOST=team.example.com');
    expect(r.out).toContain('https://203-0-113-10.sslip.io keeps working');
  });
  it('allow-git-host takes an https address only and adds it once', () => {
    expect(runHost(['allow-git-host', 'http://git.example.com/']).err).toContain('https only');
    mkdirSync(join(tmp, 'var/chart'), { recursive: true });
    writeFileSync(join(tmp, 'var/chart/values-install.yaml'), '');
    writeFileSync(join(tmp, 'etc/values.yaml'), '');
    stub('helm', `echo "helm $*" >>"${tmp}/calls.log"; exit 0`);
    expect(runHost(['allow-git-host', 'https://git.example.com/']).code).toBe(0);
    expect(runHost(['allow-git-host', 'https://git.example.com/']).out).toContain('allowed already');
    const f = readFileSync(join(tmp, 'etc/git-hosts.yaml'), 'utf8');
    expect(f.match(/git\.example\.com/g)).toHaveLength(1);
    expect(f).toContain('https://github.com/');
  });
  it('support-bundle removes what looks like a secret', () => {
    stub('kubectl', `echo "token: abcdefghijklmnop1234 and password=hunter2hunter2 and ${'A'.repeat(50)}"; exit 0`);
    stub('helm', 'exit 0');
    const r = runHost(['support-bundle']);
    expect(r.code, r.err).toBe(0);
    const file = /Wrote (\S+) /.exec(r.out)?.[1] ?? '';
    const listing = spawnSync('bash', ['-c', `tar -xzOf "${file}" ./overview.txt ./log-server.txt; rm -f "${file}"`], { encoding: 'utf8' }).stdout;
    expect(listing).not.toContain('hunter2hunter2');
    expect(listing).not.toContain('abcdefghijklmnop1234');
    expect(listing).not.toContain('A'.repeat(50));
    expect(listing).toContain('<removed>');
  });
});
