import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

describe('fetch', () => {
  const stubCurl = (): void => stub('curl', `echo "curl $*" >>"${tmp}/curl.log"; for last; do :; done; echo '{}' >"$3"`);
  it('refuses a plain http address by default, takes https, and takes http only when the operator asked for it', () => {
    stubCurl();
    const refused = bash(`fetch http://releases.example.com/release.json "${tmp}/o.json"`);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('plain http');
    expect(existsSync(join(tmp, 'curl.log'))).toBe(false);
    expect(bash(`fetch https://releases.example.com/release.json "${tmp}/o.json"`).code).toBe(0);
    expect(bash(`fetch http://releases.example.com/release.json "${tmp}/o.json"`, { MANYTHREADS_INSECURE_RELEASE_URL: '1' }).code).toBe(0);
    expect(runInstall(['--insecure-release-url', '--print-plan', '--release-url', 'x']).code).toBe(0);
  });
});

describe('uninstall', () => {
  it('deletes only the namespaces this install labelled as its own, never an apps-* name of somebody else', () => {
    mkdirSync(join(tmp, 'etc'));
    // a cluster that has a foreign apps-billing; `get ns` with the label selector answers only the platform's own team namespace
    stub('kubectl', `echo "kubectl $*" >>"${tmp}/calls.log"
case "$*" in
  *"get secret"*) exit 1 ;;
  *"get ns"*"-l"*"manythreads.io/apps=true"*) echo namespace/apps-engineering ;;
  *"get ns"*) printf 'namespace/apps-engineering\nnamespace/apps-billing\nnamespace/kube-system\nnamespace/default\n' ;;
esac
exit 0`);
    stub('helm', `echo "helm $*" >>"${tmp}/calls.log"; exit 0`);
    const r = runInstall(['--uninstall', '--yes'], { MANYTHREADS_INSTALL_FOR_TESTS: '1', MANYTHREADS_HOST_COMMAND: join(tmp, 'none') });
    expect(r.code, r.err).toBe(0);
    const log = readFileSync(join(tmp, 'calls.log'), 'utf8');
    for (const ns of ['manythreads', 'manythreads-bots', 'apps-engineering']) expect(log).toContain(`kubectl delete ns ${ns} `);
    expect(log).not.toContain('apps-billing');
    expect(log).not.toContain('delete ns kube-system');
    expect(log).not.toContain('delete ns default');
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
  it('set-domain on a bare-address install does not claim the old address keeps working', () => {
    writeFileSync(join(tmp, 'etc/install.env'), 'VERSION=0.27.0\nHOST=203.0.113.10\nADDRESS=https://203.0.113.10\nTLS_MODE=selfsigned\nADMIN_EMAIL=me@example.com\n');
    mkdirSync(join(tmp, 'var/chart'), { recursive: true });
    writeFileSync(join(tmp, 'var/chart/values-install.yaml'), '');
    writeFileSync(join(tmp, 'etc/values.yaml'), '');
    stub('helm', 'exit 0');
    stub('kubectl', `case "$*" in *certificate*) printf True ;; esac; exit 0`);
    stub('sleep', 'exit 0');
    const r = runHost(['set-domain', 'team.example.com']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toContain('keeps working');
    expect(r.out).toContain('Done: https://team.example.com');
    expect(r.out).toContain('203.0.113.10 has no certificate of its own');
    expect(readFileSync(join(tmp, 'etc/domain.yaml'), 'utf8')).not.toContain('extraDomains');
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
  describe.skipIf(!haveJq)('uninstall runs the installer only after the release names it', () => {
    const served = (): string => join(tmp, 'served');
    const sha = (f: string): string => spawnSync('sha256sum', [f], { encoding: 'utf8' }).stdout.split(' ')[0] ?? '';
    /** A release folder with a stand-in install.sh that leaves a marker; `tamper` writes another file than the one release.json names. */
    function serve(tamper = false): string {
      mkdirSync(served(), { recursive: true });
      writeFileSync(join(served(), 'install.sh'), `#!/usr/bin/env bash\necho "ran with: $*" >"${tmp}/ran.txt"\n`);
      writeFileSync(join(served(), 'release.json'), JSON.stringify(release({ installSha256: sha(join(served(), 'install.sh')) })));
      if (tamper) writeFileSync(join(served(), 'install.sh'), `#!/usr/bin/env bash\necho "ran with: $*" >"${tmp}/ran.txt"\n# changed\n`);
      return join(served(), 'release.json');
    }
    const remember = (url: string): void => writeFileSync(join(tmp, 'etc/install.env'), `VERSION=0.27.0\nHOST=a.example.com\nADDRESS=https://a.example.com\nRELEASE_URL=${url}\n`);
    const ran = (): boolean => existsSync(join(tmp, 'ran.txt'));
    it('runs the installer whose SHA-256 release.json names, and passes the arguments on', () => {
      remember(serve());
      const r = runHost(['uninstall', '--yes']);
      expect(r.code, r.err).toBe(0);
      expect(readFileSync(join(tmp, 'ran.txt'), 'utf8')).toContain('ran with: --uninstall --yes');
    });
    it('refuses a substituted installer and runs nothing', () => {
      remember(serve(true));
      const r = runHost(['uninstall', '--yes']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('install.sh does not match release.json');
      expect(ran()).toBe(false);
    });
    it('refuses a release.json without a SHA-256, and an install that does not know its release address', () => {
      const url = serve();
      writeFileSync(url, JSON.stringify(release({ installSha256: '' })));
      remember(url);
      expect(runHost(['uninstall', '--yes']).err).toContain('no SHA-256');
      remember('');
      expect(runHost(['uninstall', '--yes']).err).toContain('does not remember where releases are published');
      expect(ran()).toBe(false);
    });
    it('refuses a plain http release address unless the operator says so; https needs no flag', () => {
      serve();
      // a stand-in curl that serves the folder (the address only has to look like http or https)
      stub('curl', `out=''; while [ $# -gt 0 ]; do case "$1" in -o) shift; out="$1" ;; --max-time) shift ;; -*) ;; *) url="$1" ;; esac; shift; done; echo "curl $url" >>"${tmp}/curl.log"; cp "${served()}/$(basename "$url")" "$out"`);
      remember('http://releases.example.com/release.json');
      const refused = runHost(['uninstall', '--yes']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('plain http');
      expect(existsSync(join(tmp, 'curl.log'))).toBe(false);
      expect(ran()).toBe(false);
      const allowed = runHost(['uninstall', '--yes', '--insecure-release-url']);
      expect(allowed.code, allowed.err).toBe(0);
      expect(readFileSync(join(tmp, 'ran.txt'), 'utf8')).not.toContain('insecure');
      rmSync(join(tmp, 'ran.txt'));
      remember('https://releases.example.com/release.json');
      expect(runHost(['uninstall', '--yes']).code).toBe(0);
      expect(ran()).toBe(true);
    });
    it('upgrade keeps the same checks (and refuses http too)', () => {
      remember('http://releases.example.com/release.json');
      stub('curl', 'exit 0');
      const r = runHost(['upgrade']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('plain http');
    });
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

/**
 * P38-10: calls and TURN on a new install (docs/deploy/install.md "Calls"). The machine is described to the installer through stand-in commands and environment
 * variables (MANYTHREADS_CALLS_LOOPBACK, MANYTHREADS_DOMAIN_IPS, MANYTHREADS_CALLS_ANSWER); nothing is looked up on the network and no real firewall is touched.
 */
const PUB = '203.0.113.10'; // secret-scan:ignore documentation address used as a test fixture
const LAN = '10.0.0.5'; // secret-scan:ignore private test fixture
const CF_IP = '104.16.1.1'; // secret-scan:ignore a Cloudflare range address used as a test fixture

describe('calls: what each machine type gets', () => {
  const plan = (net: string, mode: string, pub: string, local: string, loop: string) => bash(`plan_calls '${mode}' '${pub}' '${local}' '${net}' '${loop}'`).out;
  it('(a) a public address on the machine, or a router that loops back: the address only', () => {
    expect(plan('auto', 'letsencrypt', PUB, PUB, 'unknown')).toMatch(new RegExp(`^public ${PUB} - `));
    expect(plan('auto', 'letsencrypt', PUB, LAN, 'yes')).toMatch(new RegExp(`^public ${PUB} - `));
    expect(plan('auto', 'letsencrypt', '', '198.51.100.7', 'unknown')).toMatch(/^public 198\.51\.100\.7 - /); // secret-scan:ignore test fixture
  });
  it('(b) a router that cannot loop back (or cannot be tested): the private address too', () => {
    expect(plan('auto', 'letsencrypt', PUB, LAN, 'no')).toMatch(new RegExp(`^nat ${PUB} ${LAN} .*cannot reach itself`));
    expect(plan('auto', 'selfsigned', PUB, LAN, 'unknown')).toMatch(new RegExp(`^nat ${PUB} ${LAN} .*could not be tested`));
  });
  it('a machine with no usable address gets no calls and is told to give one', () => {
    expect(plan('auto', 'letsencrypt', '', '127.0.0.1', 'unknown')).toMatch(/^off - - no usable address .*--public-ip/);
    expect(plan('auto', 'letsencrypt', '', '', 'unknown')).toMatch(/^off - - no usable address/);
  });
  it('(c) a local network only: that one private address', () => {
    expect(plan('auto', 'selfsigned', '', LAN, 'unknown')).toMatch(new RegExp(`^local ${LAN} - `));
  });
  it('(d) plain HTTP is off, whatever else is said', () => {
    expect(plan('auto', 'none', PUB, PUB, 'yes')).toMatch(/^off - - plain HTTP: browsers block the camera and the microphone/);
    expect(plan('public', 'none', PUB, PUB, 'yes')).toMatch(/^off /);
  });
  it('the override decides: public, nat (needs a public address), local', () => {
    expect(plan('public', 'letsencrypt', PUB, LAN, 'no')).toMatch(new RegExp(`^public ${PUB} - you said`));
    expect(plan('nat', 'letsencrypt', PUB, LAN, 'yes')).toMatch(new RegExp(`^nat ${PUB} ${LAN} you said`));
    expect(plan('nat', 'letsencrypt', '', LAN, 'yes')).toMatch(/^off .*--public-ip/);
    expect(plan('local', 'letsencrypt', PUB, LAN, 'yes')).toMatch(new RegExp(`^local ${LAN} - you said`));
  });
  it('knows Cloudflare\'s addresses and a site behind them', () => {
    const cf = (ip: string) => bash(`is_cloudflare_ip '${ip}' && echo yes || echo no`).out;
    expect([cf(CF_IP), cf('172.67.1.1'), cf(PUB), cf('8.8.8.8'), cf('abc')]).toEqual(['yes', 'yes', 'no', 'no', 'no']); // secret-scan:ignore test fixtures
    const behind = (mode: string, host: string, ips: string) => bash(`behind_cloudflare '${mode}' '${host}' && echo yes || echo no`, { MANYTHREADS_DOMAIN_IPS: ips }).out;
    expect(behind('cloudflare', 'a.example.com', '')).toBe('yes');
    expect(behind('letsencrypt', 'a.example.com', CF_IP)).toBe('yes');
    expect(behind('letsencrypt', 'a.example.com', PUB)).toBe('no');
    expect(behind('letsencrypt', '203-0-113-10.sslip.io', CF_IP)).toBe('no');
    expect(behind('selfsigned', PUB, CF_IP)).toBe('no');
  });
});

describe('calls: the values written and the questions asked', () => {
  const decide = (flag: string, net: string, mode: string, host: string, pub: string, local: string, env: Record<string, string> = {}) =>
    bash(`CALLS_FLAG=${flag}; CALLS_NET=${net}; decide_calls '${mode}' '${host}' '${pub}' '${local}' >/dev/null; echo "$CALLS_ON|$CALLS_TYPE|$CALLS_NODE_IP|$CALLS_INTERNAL_IP|$CALLS_REASON"`, { MANYTHREADS_CALLS_LOOPBACK: 'no', MANYTHREADS_DOMAIN_IPS: PUB, ...env }).out.split('\n').pop() ?? '';
  it('--no-calls and --tls none are off with their reason', () => {
    expect(decide('off', 'auto', 'letsencrypt', 'a.example.com', PUB, LAN)).toBe('0|off|||you chose --no-calls');
    expect(decide('on', 'auto', 'none', PUB, PUB, PUB)).toMatch(/^0\|off\|\|\|plain HTTP/);
    expect(bash(`CALLS_FLAG=auto; CALLS_NET=auto; decide_calls none ${PUB} ${PUB} ${PUB}`).out).toContain('sudo manythreads calls enable');
  });
  it('behind Cloudflare: asked first, off when nobody answers, on with --calls or a yes', () => {
    const cfEnv = { MANYTHREADS_DOMAIN_IPS: CF_IP };
    expect(decide('auto', 'auto', 'letsencrypt', 'a.example.com', PUB, LAN, cfEnv)).toMatch(/^0\|off\|\|\|behind Cloudflare/);
    expect(decide('auto', 'auto', 'cloudflare', 'a.example.com', PUB, LAN, { MANYTHREADS_CALLS_ANSWER: 'no' })).toMatch(/^0\|off/);
    expect(decide('auto', 'auto', 'cloudflare', 'a.example.com', PUB, LAN, { MANYTHREADS_CALLS_ANSWER: 'yes' })).toMatch(new RegExp(`^1\\|nat\\|${PUB}\\|${LAN}\\|`));
    expect(decide('on', 'auto', 'cloudflare', 'a.example.com', PUB, LAN)).toMatch(/^1\|nat\|/);
    // --yes never answers it
    expect(bash(`YES=1; CALLS_FLAG=auto; CALLS_NET=auto; decide_calls cloudflare a.example.com ${PUB} ${LAN}; echo "$CALLS_ON"`, { MANYTHREADS_DOMAIN_IPS: CF_IP }).out).toMatch(/\n0$/);
    expect(bash(`CALLS_FLAG=auto; CALLS_NET=auto; decide_calls cloudflare a.example.com ${PUB} ${LAN}`, { MANYTHREADS_DOMAIN_IPS: CF_IP }).out).toContain('reveal');
  });
  it('the values: public has the address; nat advertises the private address and lets the relay reach it; local lets the relay reach its one address', () => {
    const v = (t: string, n: string, i: string) => bash(`calls_values ${t} ${n} '${i}' team.example.com`).out;
    const pub = v('public', PUB, '');
    expect(pub).toContain('media:\n  enabled: true');
    expect(pub).toContain('  ingressPath: /livekit');
    expect(pub).toContain(`  nodeIp: ${PUB}`);
    expect(pub).toContain('  useExternalIp: false');
    expect(pub).toContain('    enabled: true\n    domain: team.example.com\n    tlsPort: 0');
    expect(pub).not.toContain('advertiseInternalIp');
    expect(pub).not.toContain('allowRestrictedPeerCidrs');
    const nat = v('nat', PUB, LAN);
    expect(nat).toContain('  advertiseInternalIp: true');
    expect(nat).toContain(`    allowRestrictedPeerCidrs: [${LAN}/32]`);
    expect(nat).toContain(`  nodeIp: ${PUB}`);
    const local = v('local', LAN, '');
    expect(local).toContain(`  nodeIp: ${LAN}`);
    expect(local).toContain(`    allowRestrictedPeerCidrs: [${LAN}/32]`);
    expect(local).not.toContain('advertiseInternalIp');
  });
  it('write_values puts the calls block in the install\'s own file, after the images, and nothing else changes', () => {
    if (!haveJq) return;
    const rel = join(tmp, 'release.json');
    writeFileSync(rel, JSON.stringify(release()));
    const a = join(tmp, 'a.yaml');
    const b = join(tmp, 'b.yaml');
    expect(bash(`write_values "${a}" "${rel}" letsencrypt team.example.com - me@example.com staging true ""`).code).toBe(0);
    expect(bash(`write_values "${b}" "${rel}" letsencrypt team.example.com - me@example.com staging true "" "$(calls_values public ${PUB} '' team.example.com)"`).code).toBe(0);
    const fa = readFileSync(a, 'utf8');
    const fb = readFileSync(b, 'utf8');
    expect(fa).not.toContain('media:');
    const body = (t: string) => t.split('\n').filter((l) => !l.startsWith('#'));
    const at = body(fb).indexOf('media:');
    expect(at).toBeGreaterThan(0);
    expect(body(fb).slice(0, at)).toEqual(body(fa).filter((l) => l !== ''));
    expect(fb).toContain('\nmedia:\n  enabled: true');
    expect(readFileSync(join(chart, 'values-install.yaml'), 'utf8')).toContain('media:\n  enabled: false');
  });
  it.skipIf(!haveJq || !haveHelm)('each machine type renders with the real chart: signalling on the main address, TURN without TLS, the relay may reach the private address', () => {
    const rel = join(tmp, 'release.json');
    writeFileSync(rel, JSON.stringify(release()));
    const render = (type: string, node: string, internal: string) => {
      const out = join(tmp, `${type}.yaml`);
      const w = bash(`write_values "${out}" "${rel}" letsencrypt team.example.com - me@example.com staging true "" "$(calls_values ${type} ${node} '${internal}' team.example.com)"`);
      expect(w.code, w.err).toBe(0);
      const r = spawnSync('helm', ['template', 'manythreads', chart, '-n', 'manythreads', '-f', join(chart, 'values-install.yaml'), '-f', out, '--set', 'hermesPods.apiServer.cidr=10.0.2.15/32'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    for (const [t, n, i] of [['public', PUB, ''], ['nat', PUB, LAN], ['local', LAN, '']] as const) {
      const rendered = render(t, n, i);
      expect(rendered, t).toContain('name: manythreads-media');
      expect(rendered, t).toContain(`node_ip: "${n}"`);
      expect(rendered, t).toContain('/livekit');
      expect(rendered, t).toContain('MANYTHREADS_LIVEKIT_URL, value: "wss://team.example.com/livekit"');
      expect(rendered, t).not.toContain('tls_port');
      if (t !== 'public') expect(rendered, t).toContain(`${i || n}/32`);
    }
    expect(render('nat', PUB, LAN)).toContain('advertise_internal_ip');
  });
});

describe('calls: the firewall', () => {
  const lines = (kind: string) => bash(`firewall_lines ${kind}`).out;
  it('prints the exact lines for each tool: the four call ports, and 7880 for the pods only', () => {
    expect(lines('ufw')).toContain('ufw allow 3478/udp');
    expect(lines('ufw')).toContain('ufw allow 50000:50100/udp');
    expect(lines('ufw')).toContain('ufw allow 50101:50300/udp');
    expect(lines('ufw')).toContain('ufw allow 7881/tcp');
    expect(lines('ufw')).toContain('ufw allow from 10.42.0.0/16 to any port 7880 proto tcp');
    expect(lines('ufw')).not.toMatch(/ufw allow 7880/);
    expect(lines('firewalld')).toContain('firewall-cmd --permanent --add-port=50101-50300/udp');
    expect(lines('firewalld')).toContain('firewall-cmd --reload');
    expect(lines('iptables')).toContain('iptables -I INPUT -p udp --dport 50000:50100 -j ACCEPT');
    expect(lines('iptables')).toContain('iptables -I INPUT -p tcp --dport 7880 -j DROP');
  });
});

describe.skipIf(!haveJq)('calls: a whole install on a stand-in machine', () => {
  const calls = (): string => (existsSync(join(tmp, 'calls.log')) ? readFileSync(join(tmp, 'calls.log'), 'utf8') : '');
  const file = (f: string): string => readFileSync(join(tmp, f), 'utf8');
  /** Stand-ins for the cluster and the firewall tools: every call is recorded, nothing real is touched (a real `iptables` here would change this machine). */
  function machine(src: string): void {
    for (const c of ['helm', 'k3s']) stub(c, `echo "${c} $*" >>"${tmp}/calls.log"; exit 0`);
    stub('kubectl', `echo "kubectl $*" >>"${tmp}/calls.log"; case "$*" in *certificate*) printf True ;; esac; exit 0`);
    stub('sleep', 'exit 0');
    stub('openssl', 'cat >/dev/null; printf x');
    stub('curl', 'exit 22');
    stub('ip', `echo "1.1.1.1 via 10.0.0.1 dev eth0 src ${src} uid 0"`); // secret-scan:ignore test fixture
    stub('ufw', `case "$1" in status) echo "Status: \${FAKE_UFW:-inactive}"; [ -z "\${FAKE_UFW_RULES:-}" ] || printf '%b\\n' "$FAKE_UFW_RULES" ;; *) echo "ufw $*" >>"${tmp}/calls.log" ;; esac; exit 0`);
    stub('firewall-cmd', `case "$*" in *--query-source*) exit 1 ;; --state) echo "\${FAKE_FWD:-not running}"; [ "\${FAKE_FWD:-}" = running ] ;; --list-ports) echo "\${FAKE_FWD_PORTS:-}" ;; *) echo "firewall-cmd $*" >>"${tmp}/calls.log" ;; esac`);
    stub('iptables', `case "$1" in -S) echo "-P INPUT \${FAKE_IPT_POLICY:-ACCEPT}" ;; -C) exit 1 ;; *) echo "iptables $*" >>"${tmp}/calls.log" ;; esac; exit 0`);
    // a chart folder, a release that names the host command by its SHA-256
    mkdirSync(join(tmp, 'chartdir'), { recursive: true });
    writeFileSync(join(tmp, 'chartdir/values-install.yaml'), '');
    mkdirSync(join(tmp, 'rel'), { recursive: true });
    writeFileSync(join(tmp, 'rel/manythreads'), readFileSync(host));
    const sha = spawnSync('sha256sum', [join(tmp, 'rel/manythreads')], { encoding: 'utf8' }).stdout.split(' ')[0] ?? '';
    writeFileSync(join(tmp, 'rel/release.json'), JSON.stringify(release({ hostCommandSha256: sha })));
  }
  const install = (args: string[], env: Record<string, string> = {}) =>
    runInstall(['--release-url', join(tmp, 'rel/release.json'), '--chart', join(tmp, 'chartdir'), '--admin-email', 'me@example.com', ...args], {
      MANYTHREADS_INSTALL_FOR_TESTS: '1',
      MANYTHREADS_HOST_COMMAND: join(tmp, 'mt'),
      MANYTHREADS_DOMAIN_IPS: PUB,
      ...env,
    });
  const state = (): string => file('etc/install.env');

  it('(a) a public address on the machine: the address, TURN without TLS, state says on', () => {
    machine(PUB);
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB]);
    expect(r.code, r.err).toBe(0);
    const v = file('etc/values.yaml');
    expect(v).toContain(`media:\n  enabled: true`);
    expect(v).toContain(`  nodeIp: ${PUB}`);
    expect(v).toContain('  ingressPath: /livekit');
    expect(v).toContain('    tlsPort: 0');
    expect(v).not.toContain('advertiseInternalIp');
    expect(state()).toContain('CALLS=1');
    expect(state()).toContain('CALLS_TYPE=public');
    expect(r.out).toContain('Machine type "public"');
    expect(r.out).toContain('Calls:     on (public)');
    expect(readFileSync(join(chart, 'values-install.yaml'), 'utf8')).toContain('media:\n  enabled: false'); // the profile is not touched
    expect(calls()).toContain('rollout status deploy/manythreads-media');
  });
  it('(b) behind a router that cannot loop back: both addresses, the relay may reach the private one', () => {
    machine(LAN);
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB], { MANYTHREADS_CALLS_LOOPBACK: 'no' });
    expect(r.code, r.err).toBe(0);
    const v = file('etc/values.yaml');
    expect(v).toContain(`  nodeIp: ${PUB}`);
    expect(v).toContain('  advertiseInternalIp: true');
    expect(v).toContain(`    allowRestrictedPeerCidrs: [${LAN}/32]`);
    expect(state()).toContain('CALLS_TYPE=nat');
    expect(r.out).toContain('cannot reach itself');
  });
  it('a router that loops back is the same as a public address', () => {
    machine(LAN);
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB], { MANYTHREADS_CALLS_LOOPBACK: 'yes' });
    expect(r.code, r.err).toBe(0);
    expect(file('etc/values.yaml')).not.toContain('advertiseInternalIp');
    expect(state()).toContain('CALLS_TYPE=public');
  });
  it('(c) a local network only: the private address', () => {
    machine(LAN);
    const r = install(['--tls', 'selfsigned']);
    expect(r.code, r.err).toBe(0);
    const v = file('etc/values.yaml');
    expect(v).toContain(`  nodeIp: ${LAN}`);
    expect(v).toContain(`    allowRestrictedPeerCidrs: [${LAN}/32]`);
    expect(state()).toContain('CALLS_TYPE=local');
  });
  it('--calls-network overrides what was found', () => {
    machine(LAN);
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB, '--calls-network', 'local']);
    expect(r.code, r.err).toBe(0);
    expect(file('etc/values.yaml')).toContain(`  nodeIp: ${LAN}`);
    expect(runInstall(['--calls-network', 'maybe', '--print-plan']).err).toContain('--calls-network wants');
  });
  it('an existing cluster (--kubeconfig) gets no calls unless --calls is given: it may not have Traefik', () => {
    machine(PUB);
    writeFileSync(join(tmp, 'kc'), 'x');
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB, '--kubeconfig', join(tmp, 'kc'), '--yes']);
    expect(r.code, r.err).toBe(0);
    expect(file('etc/values.yaml')).not.toContain('media:');
    expect(r.out).toContain('--kubeconfig');
  });
  it('--no-calls leaves everything out: no media values, no firewall, state off', () => {
    machine(PUB);
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB, '--no-calls'], { FAKE_UFW: 'active' });
    expect(r.code, r.err).toBe(0);
    expect(file('etc/values.yaml')).not.toContain('media:');
    expect(state()).toContain('CALLS=0');
    expect(calls()).not.toContain('ufw allow');
    expect(calls()).not.toContain('manythreads-media');
    expect(r.out).toContain('Calls:     off (you chose --no-calls)');
  });
  it('(d) --tls none leaves calls off and says why, even with --calls', () => {
    machine(PUB);
    const r = install(['--tls', 'none', '--public-ip', PUB, '--calls']);
    expect(r.code, r.err).toBe(0);
    expect(file('etc/values.yaml')).not.toContain('media:');
    expect(r.out).toContain('plain HTTP');
    expect(r.out).toContain('Calls:     off');
    expect(calls()).not.toContain('iptables');
  });
  it('(e) behind Cloudflare: off when nobody can be asked, on with --calls or a yes, off with a no', () => {
    machine(LAN);
    writeFileSync(join(tmp, 'o.pem'), 'x');
    const cf = ['--tls', 'cloudflare', '--domain', 'team.example.com', '--origin-cert', join(tmp, 'o.pem'), '--origin-key', join(tmp, 'o.pem'), '--public-ip', PUB];
    const off = install(cf, { MANYTHREADS_CALLS_LOOPBACK: 'no' });
    expect(off.code, off.err).toBe(0);
    expect(off.out).toContain("reveal");
    expect(file('etc/values.yaml')).not.toContain('media:');
    expect(state()).toContain('CALLS=0');
    rmSync(join(tmp, 'etc'), { recursive: true });
    const yes = install(cf, { MANYTHREADS_CALLS_LOOPBACK: 'no', MANYTHREADS_CALLS_ANSWER: 'yes' });
    expect(yes.code, yes.err).toBe(0);
    expect(file('etc/values.yaml')).toContain('media:\n  enabled: true');
    rmSync(join(tmp, 'etc'), { recursive: true });
    const flag = install([...cf, '--calls'], { MANYTHREADS_CALLS_LOOPBACK: 'no' });
    expect(flag.code, flag.err).toBe(0);
    expect(file('etc/values.yaml')).toContain('media:\n  enabled: true');
    rmSync(join(tmp, 'etc'), { recursive: true });
    const no = install(cf, { MANYTHREADS_CALLS_LOOPBACK: 'no', MANYTHREADS_CALLS_ANSWER: 'no' });
    expect(file('etc/values.yaml')).not.toContain('media:');
    expect(no.code, no.err).toBe(0);
  });
  it('ufw active: opens each missing call port, the pods may reach 7880, 7880 is not opened', () => {
    machine(PUB);
    const rules = '3478/udp ALLOW Anywhere\\nDefault: deny (incoming), allow (outgoing)';
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB], { FAKE_UFW: 'active', FAKE_UFW_RULES: rules });
    expect(r.code, r.err).toBe(0);
    const c = calls();
    expect(c).not.toContain('ufw allow 3478/udp'); // open already
    for (const l of ['ufw allow 50000:50100/udp', 'ufw allow 50101:50300/udp', 'ufw allow 7881/tcp', 'ufw allow from 10.42.0.0/16 to any port 7880 proto tcp']) expect(c).toContain(l);
    expect(c).not.toMatch(/ufw allow 7880/);
    expect(c).not.toContain('ufw deny 7880'); // the default already denies
    expect(r.out).toContain('UDP 3478: open already');
  });
  it('ufw active with a permissive default: 7880 is denied after the pods are allowed', () => {
    machine(PUB);
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB], { FAKE_UFW: 'active', FAKE_UFW_RULES: 'Default: allow (incoming)' });
    expect(r.code, r.err).toBe(0);
    const c = calls();
    expect(c.indexOf('ufw allow from 10.42.0.0/16')).toBeGreaterThan(-1);
    expect(c.indexOf('ufw deny 7880/tcp')).toBeGreaterThan(c.indexOf('ufw allow from 10.42.0.0/16'));
  });
  it('firewalld running: the ports are added permanently, the pod network is trusted, then it reloads', () => {
    machine(PUB);
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB], { FAKE_FWD: 'running' });
    expect(r.code, r.err).toBe(0);
    const c = calls();
    for (const l of ['--add-port=3478/udp', '--add-port=50000-50100/udp', '--add-port=50101-50300/udp', '--add-port=7881/tcp', '--zone=trusted --add-source=10.42.0.0/16']) expect(c).toContain(l);
    expect(c).not.toContain('--add-port=7880');
    expect(c.indexOf('firewall-cmd --reload')).toBeGreaterThan(c.indexOf('--add-port=7881/tcp'));
  });
  it('iptables with a DROP policy: the ports are accepted and 7880 is dropped for outsiders, with the pods and this machine accepted', () => {
    machine(PUB);
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB], { FAKE_IPT_POLICY: 'DROP' });
    expect(r.code, r.err).toBe(0);
    const c = calls();
    expect(c).toContain('iptables -I INPUT -p udp --dport 50101:50300 -j ACCEPT');
    expect(c).toContain('iptables -I INPUT -p tcp --dport 7880 -j DROP');
    expect(c).toContain('iptables -I INPUT -p tcp --dport 7880 -s 10.42.0.0/16 -j ACCEPT');
  });
  it('no active firewall: no port is opened, 7880 is still closed to outsiders, the provider firewall is mentioned', () => {
    machine(PUB);
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB]);
    expect(r.code, r.err).toBe(0);
    expect(calls()).not.toContain('--dport 3478');
    expect(calls()).toContain('iptables -I INPUT -p tcp --dport 7880 -j DROP');
    expect(r.out).toContain('no active firewall');
    expect(r.out).toContain('security group');
  });
  it('--no-firewall touches nothing and prints the lines to run', () => {
    machine(PUB);
    const r = install(['--tls', 'letsencrypt', '--domain', 'team.example.com', '--public-ip', PUB, '--no-firewall'], { FAKE_UFW: 'active' });
    expect(r.code, r.err).toBe(0);
    expect(calls()).not.toMatch(/ufw (allow|deny)/);
    expect(calls()).not.toContain('iptables -I');
    expect(r.out).toContain('left alone (--no-firewall)');
    expect(r.out).toContain('ufw allow 50000:50100/udp');
    expect(file('etc/values.yaml')).toContain('media:\n  enabled: true'); // calls are still on
  });

  describe('existing installs', () => {
    function existing(extra = ''): void {
      machine(LAN);
      mkdirSync(join(tmp, 'etc'), { recursive: true });
      mkdirSync(join(tmp, 'var/chart'), { recursive: true });
      writeFileSync(join(tmp, 'var/chart/values-install.yaml'), '');
      mkdirSync(join(tmp, 'var/chart/templates'));
      writeFileSync(join(tmp, 'var/chart/templates/media.yaml'), '');
      writeFileSync(join(tmp, 'var/chart/values.yaml'), 'media:\n  advertiseInternalIp: false\n');
      writeFileSync(join(tmp, 'etc/install.env'), `VERSION=0.27.0\nHOST=team.example.com\nADDRESS=https://team.example.com\nTLS_MODE=letsencrypt\nADMIN_EMAIL=me@example.com\nRELEASE_URL=${join(tmp, 'rel/release.json')}\n${extra}`);
      const rel = join(tmp, 'r0.json');
      writeFileSync(rel, JSON.stringify(release()));
      expect(bash(`write_values "${join(tmp, 'etc/values.yaml')}" "${rel}" letsencrypt team.example.com - me@example.com production true ""`).code).toBe(0);
    }
    it('an upgrade never changes what the install has: no media in its file, no calls.yaml, no firewall, no state key', () => {
      existing();
      writeFileSync(join(tmp, 'rel/release.json'), JSON.stringify(release({ version: '0.28.0', hostCommandSha256: spawnSync('sha256sum', [join(tmp, 'rel/manythreads')], { encoding: 'utf8' }).stdout.split(' ')[0] })));
      const r = install(['--upgrade'], { FAKE_UFW: 'active' });
      expect(r.code, r.err).toBe(0);
      expect(file('etc/values.yaml')).not.toContain('media:');
      expect(existsSync(join(tmp, 'etc/calls.yaml'))).toBe(false);
      expect(state()).not.toContain('CALLS');
      expect(calls()).not.toContain('ufw allow');
      expect(calls()).not.toContain('calls.yaml');
    });
    it('an upgrade keeps applying calls.yaml, before domain.yaml', () => {
      existing('CALLS=1\n');
      writeFileSync(join(tmp, 'etc/calls.yaml'), 'media:\n  enabled: true\n');
      writeFileSync(join(tmp, 'etc/domain.yaml'), 'domain: team.example.com\n');
      writeFileSync(join(tmp, 'rel/release.json'), JSON.stringify(release({ version: '0.28.0', hostCommandSha256: spawnSync('sha256sum', [join(tmp, 'rel/manythreads')], { encoding: 'utf8' }).stdout.split(' ')[0] })));
      const r = install(['--upgrade']);
      expect(r.code, r.err).toBe(0);
      const helmLine = calls().split('\n').find((l) => l.startsWith('helm upgrade --install')) ?? '';
      expect(helmLine.indexOf('calls.yaml')).toBeGreaterThan(helmLine.indexOf('values.yaml'));
      expect(helmLine.indexOf('domain.yaml')).toBeGreaterThan(helmLine.indexOf('calls.yaml'));
    });
    it('--calls-enable writes calls.yaml, applies it, opens the firewall, records the state; run again it writes the same', () => {
      existing();
      const args = ['--calls-enable', '--public-ip', PUB];
      const r = runInstall(args, { MANYTHREADS_INSTALL_FOR_TESTS: '1', MANYTHREADS_DOMAIN_IPS: PUB, MANYTHREADS_CALLS_LOOPBACK: 'no', FAKE_UFW: 'active', FAKE_UFW_RULES: 'Default: deny (incoming)' });
      expect(r.code, r.err).toBe(0);
      const first = file('etc/calls.yaml');
      expect(first).toContain(`  nodeIp: ${PUB}`);
      expect(first).toContain('  advertiseInternalIp: true'); // the stand-in machine's own address is private and the router "cannot loop back"
      expect(statSync(join(tmp, 'etc/calls.yaml')).mode & 0o777).toBe(0o600);
      expect(state()).toContain('CALLS=1');
      expect(calls()).toContain('ufw allow 50000:50100/udp');
      expect(calls()).toContain('-f ' + join(tmp, 'etc/calls.yaml'));
      expect(file('etc/values.yaml')).not.toContain('media:');
      const again = runInstall(args, { MANYTHREADS_INSTALL_FOR_TESTS: '1', MANYTHREADS_DOMAIN_IPS: PUB, MANYTHREADS_CALLS_LOOPBACK: 'no', FAKE_UFW: 'active', FAKE_UFW_RULES: 'Default: deny (incoming)' });
      expect(again.code, again.err).toBe(0);
      expect(file('etc/calls.yaml').replace(/^#.*\n/gm, '')).toBe(first.replace(/^#.*\n/gm, ''));
      expect(state().match(/^CALLS=/gm)).toHaveLength(1);
    });
    it('--calls-enable on plain HTTP changes nothing and fails with the reason; --no-calls is a contradiction', () => {
      existing();
      writeFileSync(join(tmp, 'etc/install.env'), 'VERSION=0.27.0\nHOST=203.0.113.10\nTLS_MODE=none\n');
      const r = runInstall(['--calls-enable'], { MANYTHREADS_INSTALL_FOR_TESTS: '1' });
      expect(r.code).toBe(1);
      expect(r.out).toContain('plain HTTP');
      expect(existsSync(join(tmp, 'etc/calls.yaml'))).toBe(false);
      expect(runInstall(['--calls-enable', '--no-calls'], { MANYTHREADS_INSTALL_FOR_TESTS: '1' }).err).toContain('opposite');
    });
    it('--calls-enable refuses a chart that is older than calls and changes nothing', () => {
      existing();
      rmSync(join(tmp, 'var/chart/templates'), { recursive: true });
      const r = runInstall(['--calls-enable', '--public-ip', PUB], { MANYTHREADS_INSTALL_FOR_TESTS: '1' });
      expect(r.code).toBe(1);
      expect(r.err).toContain('older than calls');
      expect(existsSync(join(tmp, 'etc/calls.yaml'))).toBe(false);
      expect(state()).not.toContain('CALLS');
    });
    it('--calls-enable on a machine that has no install says so', () => {
      machine(PUB);
      expect(runInstall(['--calls-enable'], { MANYTHREADS_INSTALL_FOR_TESTS: '1' }).err).toContain('not installed');
    });
  });
});

describe('the --print-plan of calls', () => {
  const plan = (args: string[]) => runInstall(['--print-plan', '--release-url', 'x', '--public-ip', PUB, ...args], { MANYTHREADS_DOMAIN_IPS: PUB }).out;
  it('says what calls will be, without changing anything', () => {
    expect(plan([])).toMatch(/calls: +(nat|public): /);
    expect(plan(['--no-calls'])).toContain('calls:         off (--no-calls)');
    expect(plan(['--tls', 'none'])).toContain('calls:         off (plain HTTP');
    expect(plan(['--calls-network', 'local'])).toContain('calls:         local:');
    expect(existsSync(join(tmp, 'etc'))).toBe(false);
  });
});

describe('manythreads calls', () => {
  const runHost = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [host, ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env['PATH']}`, HOME: tmp, MANYTHREADS_ETC: join(tmp, 'etc'), MANYTHREADS_VAR: join(tmp, 'var'), KUBECONFIG: join(tmp, 'kubeconfig'), ...env },
    });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  beforeEach(() => {
    mkdirSync(join(tmp, 'etc'));
    writeFileSync(join(tmp, 'etc/install.env'), `VERSION=0.27.0\nHOST=team.example.com\nADDRESS=https://team.example.com\nTLS_MODE=letsencrypt\nCALLS=1\nCALLS_NODE_IP=${PUB}\n`);
    stub('id', 'echo 0');
  });

  describe('enable', () => {
    it('refuses a missing or unknown subcommand and a bad flag, and runs nothing', () => {
      expect(runHost(['calls']).err).toContain('usage: manythreads calls enable');
      expect(runHost(['calls', 'frob']).err).toContain('usage: manythreads calls enable');
      expect(runHost(['calls', 'enable', '--wat']).err).toContain('unknown option --wat');
      expect(runHost(['calls', 'enable', '--calls-network', 'maybe']).err).toContain('--calls-network wants');
      expect(runHost(['calls', 'enable', '--public-ip']).err).toContain('needs a value');
      expect(runHost(['calls', 'enable', '--calls']).err).toContain('does not remember where releases are published');
    });
    it('runs the installer the release names, in its --calls-enable mode, with the flags passed on', () => {
      mkdirSync(join(tmp, 'served'));
      writeFileSync(join(tmp, 'served/install.sh'), `#!/usr/bin/env bash\necho "ran with: $*" >"${tmp}/ran.txt"\n`);
      const sha = spawnSync('sha256sum', [join(tmp, 'served/install.sh')], { encoding: 'utf8' }).stdout.split(' ')[0] ?? '';
      if (!haveJq) return;
      writeFileSync(join(tmp, 'served/release.json'), JSON.stringify(release({ installSha256: sha })));
      const url = join(tmp, 'served/release.json');
      writeFileSync(join(tmp, 'etc/install.env'), `VERSION=0.27.0\nHOST=team.example.com\nRELEASE_URL=${url}\n`);
      const r = runHost(['calls', 'enable', '--calls', '--calls-network', 'nat', '--public-ip', PUB, '--no-firewall']);
      expect(r.code, r.err).toBe(0);
      expect(readFileSync(join(tmp, 'ran.txt'), 'utf8')).toContain(`ran with: --calls-enable --release-url ${url} --calls --calls-network nat --public-ip ${PUB} --no-firewall`);
      // a substituted installer is never run
      writeFileSync(join(tmp, 'served/install.sh'), '#!/usr/bin/env bash\necho changed\n');
      rmSync(join(tmp, 'ran.txt'));
      expect(runHost(['calls', 'enable']).err).toContain('install.sh does not match release.json');
      expect(existsSync(join(tmp, 'ran.txt'))).toBe(false);
    });
    it('says so when manythreads is not installed here', () => {
      rmSync(join(tmp, 'etc/install.env'));
      expect(runHost(['calls', 'check']).err).toContain('not installed');
    });
  });

  describe('check', () => {
    const UFW_OPEN = 'Status: active\\n3478/udp ALLOW Anywhere\\n50000:50100/udp ALLOW Anywhere\\n50101:50300/udp ALLOW Anywhere\\n7881/tcp ALLOW Anywhere';
    /** A healthy stand-in: the media pod ready, the ingress answers 200, TURN answers, ufw has every call port and no 7880, the configured address is this machine's. */
    function healthy(over: { ufw?: string; listen7880?: string; exec?: number; ready?: string; deploy?: boolean; http?: string } = {}): void {
      stub(
        'kubectl',
        `echo "kubectl $*" >>"${tmp}/calls.log"
case "$*" in
  *"get deploy manythreads-media -o jsonpath"*) printf '${over.ready ?? '1'}' ;;
  *"get deploy manythreads-media"*) exit ${over.deploy === false ? 1 : 0} ;;
  *"get cm manythreads-media-config"*) printf '    node_ip: "${PUB}"\\n' ;;
  *" exec "*) exit ${over.exec ?? 0} ;;
esac
exit 0`,
      );
      stub('curl', `case "$*" in *livekit*) printf '${over.http ?? '200'}' ;; *) exit 22 ;; esac`);
      stub('ss', `case "$*" in *3478*) echo "UNCONN 0 0 0.0.0.0:3478 0.0.0.0:*" ;; *7880*) echo "${over.listen7880 ?? 'LISTEN 0 4096 0.0.0.0:7880 0.0.0.0:*'}" ;; esac`);
      stub('python3', 'exit 0');
      stub('ufw', `case "$1" in status) printf '${over.ufw ?? UFW_OPEN}\\n' ;; esac; exit 0`);
      stub('firewall-cmd', 'echo "not running"; exit 252');
      stub('iptables', 'echo "-P INPUT ACCEPT"; exit 1');
    }
    const env = { MANYTHREADS_DETECTED_PUBLIC_IP: PUB, MANYTHREADS_DETECTED_LOCAL_IP: LAN };
    it('a healthy install: every line PASS, exit 0, no secret', () => {
      healthy();
      const r = runHost(['calls', 'check'], env);
      expect(r.code, r.out).toBe(0);
      expect(r.out).not.toContain('FAIL');
      for (const p of [
        'the media pod is ready',
        'the signalling answers at wss://team.example.com/livekit through the ingress',
        'TURN answers on UDP 3478 on this machine',
        'UDP 3478 is open in ufw',
        'UDP 50000-50100 is open in ufw',
        'UDP 50101-50300 is open in ufw',
        'TCP 7881 is open in ufw',
        "TCP 7880 (LiveKit's signalling) is not open to outsiders",
        `the call address ${PUB} is this machine's address (public)`,
        'the server has the call address and key, and reaches the media pod',
      ])
        expect(r.out, p).toContain(`PASS: ${p}`);
      expect(r.out).not.toMatch(/api-?key|secret|token/i);
    });
    it('calls that are not on: one FAIL, exit 1', () => {
      healthy({ deploy: false });
      const r = runHost(['calls', 'check'], env);
      expect(r.code).toBe(1);
      expect(r.out).toContain('FAIL: calls are not turned on here');
      expect(r.out).toContain('sudo manythreads calls enable');
    });
    it('a pod that is not ready, an ingress that does not answer, and a server that cannot use the pod each fail', () => {
      healthy({ ready: '', http: '404', exec: 3 });
      const r = runHost(['calls', 'check'], env);
      expect(r.code).toBe(1);
      expect(r.out).toContain('FAIL: the media pod is not ready');
      expect(r.out).toContain('FAIL: https://team.example.com/livekit/ answered 404');
      expect(r.out).toContain('FAIL: the server cannot use the media pod');
    });
    it('a closed firewall port fails with the port named', () => {
      healthy({ ufw: 'Status: active\\n3478/udp ALLOW Anywhere\\n50000:50100/udp ALLOW Anywhere\\n50101:50300/udp ALLOW Anywhere' });
      const r = runHost(['calls', 'check'], env);
      expect(r.code).toBe(1);
      expect(r.out).toContain('FAIL: TCP 7881 is not open in ufw');
      expect(r.out).toContain('PASS: UDP 3478 is open in ufw');
    });
    it('7880 open to everyone fails; listening on the loopback only passes', () => {
      healthy({ ufw: `${UFW_OPEN}\\n7880/tcp ALLOW Anywhere` });
      const open = runHost(['calls', 'check'], env);
      expect(open.code).toBe(1);
      expect(open.out).toContain("FAIL: TCP 7880 (LiveKit's signalling) is open to everyone");
      healthy({ ufw: `${UFW_OPEN}\\n7880/tcp ALLOW Anywhere`, listen7880: 'LISTEN 0 4096 127.0.0.1:7880 0.0.0.0:*' });
      expect(runHost(['calls', 'check'], env).code).toBe(0);
    });
    it('with no firewall on the machine every port passes with a note about the provider, and 7880 fails until it is closed', () => {
      healthy({ ufw: 'Status: inactive' });
      const r = runHost(['calls', 'check'], env);
      expect(r.out).toContain("a provider's network firewall cannot be seen from here");
      expect(r.out).toContain('FAIL: TCP 7880');
      expect(r.code).toBe(1);
    });
    it('the installer\'s own iptables rule for 7880 is not mistaken for a firewall: the ports pass and 7880 is closed', () => {
      healthy({ ufw: 'Status: inactive' });
      stub('iptables', 'case "$*" in "-S INPUT") echo "-P INPUT ACCEPT"; echo "-A INPUT -p tcp -m tcp --dport 7880 -j DROP" ;; "-C INPUT -p tcp --dport 7880 -j DROP") exit 0 ;; *) exit 1 ;; esac');
      const r = runHost(['calls', 'check'], env);
      expect(r.out).toContain('PASS: UDP 3478: no firewall on this machine blocks it');
      expect(r.out).toContain("PASS: TCP 7880 (LiveKit's signalling) is not open to outsiders");
      expect(r.code, r.out).toBe(0);
    });
    it('a call address that is no longer this machine\'s fails; one that cannot be looked up is not compared', () => {
      healthy();
      expect(runHost(['calls', 'check'], { MANYTHREADS_DETECTED_PUBLIC_IP: '', MANYTHREADS_DETECTED_LOCAL_IP: LAN }).out).toContain('was not compared');
      healthy();
      const r = runHost(['calls', 'check'], { MANYTHREADS_DETECTED_PUBLIC_IP: '198.51.100.9', MANYTHREADS_DETECTED_LOCAL_IP: LAN }); // secret-scan:ignore test fixture
      expect(r.code).toBe(1);
      expect(r.out).toContain(`FAIL: the call address is ${PUB} but this machine's address is 198.51.100.9`); // secret-scan:ignore test fixture
    });
  });

  it('set-domain moves TURN\'s name with the domain when calls are on', () => {
    mkdirSync(join(tmp, 'var/chart'), { recursive: true });
    writeFileSync(join(tmp, 'var/chart/values-install.yaml'), '');
    writeFileSync(join(tmp, 'etc/values.yaml'), '');
    writeFileSync(join(tmp, 'etc/calls.yaml'), 'media:\n  enabled: true\n');
    stub('helm', `echo "helm $*" >>"${tmp}/calls.log"; exit 0`);
    stub('kubectl', `case "$*" in *certificate*) printf True ;; esac; exit 0`);
    stub('sleep', 'exit 0');
    const r = runHost(['set-domain', 'new.example.com']);
    expect(r.code, r.err).toBe(0);
    const f = readFileSync(join(tmp, 'etc/domain.yaml'), 'utf8');
    expect(f).toContain('media:\n  turn:\n    domain: new.example.com');
    expect(f).not.toContain('publicUrl: wss');
    const helmLine = readFileSync(join(tmp, 'calls.log'), 'utf8').split('\n').find((l) => l.startsWith('helm upgrade')) ?? '';
    expect(helmLine.indexOf('domain.yaml')).toBeGreaterThan(helmLine.indexOf('calls.yaml'));
  });
});
