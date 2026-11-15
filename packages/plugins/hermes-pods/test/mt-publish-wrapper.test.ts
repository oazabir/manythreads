import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `mt-publish` (P26-05): the command a bot types on the Hermes workbench, the same words as in an agent pod and on a server. It only passes `check` and `publish` on to
// `sudo -u repo mt-publish.sh`; the sudoers file and the script do the real checking. A stand-in `sudo` records what it is asked to run.

const WRAPPER = fileURLToPath(new URL('../../../../deploy/images/workbench/mt-publish', import.meta.url));
let dir = '';
let log = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-publish-wrapper-'));
  log = join(dir, 'sudo.log');
  writeFileSync(join(dir, 'sudo'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncat > /dev/null\n`);
  chmodSync(join(dir, 'sudo'), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], input = '') => {
  writeFileSync(log, '');
  const r = spawnSync('sh', [WRAPPER, ...args], { encoding: 'utf8', input, env: { PATH: `${dir}:/usr/bin:/bin` } });
  return { status: r.status, stderr: r.stderr, sudo: readFileSync(log, 'utf8').trim() };
};

describe('the workbench `mt-publish`', () => {
  it('asks the repo user to run mt-publish.sh check, and nothing else', () => {
    expect(run(['check', 'widgets'])).toMatchObject({ status: 0, sudo: '-n -u repo /usr/local/bin/mt-publish.sh check widgets' });
  });

  it('passes a publish through whole, with the title and the two author arguments as single arguments', () => {
    const r = run(['publish', 'widgets', '1a2b3c4d-1111-4222-8333-444455556666', 'abc1234', 'P26-05: fix the rota', 'Nadia Q', 'nadia@example.test'], 'text');
    expect(r.status).toBe(0);
    expect(r.sudo).toBe('-n -u repo /usr/local/bin/mt-publish.sh publish widgets 1a2b3c4d-1111-4222-8333-444455556666 abc1234 P26-05: fix the rota Nadia Q nadia@example.test');
  });

  it('refuses any other first word, and no words, with a usage line and without calling sudo', () => {
    for (const args of [[], ['push', 'widgets'], ['--help'], ['/bin/sh']]) {
      const r = run(args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toContain('usage: mt-publish');
      expect(r.sudo).toBe('');
    }
  });
});
