import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('reads and removes the key where the bridge keeps it after a rotation, not only the installer\'s copy', () => {
    expect(script).toMatch(/live_key_file\(\)/);
    expect(script).toContain('rm -f "$DATA/state/key"');
  });
});
