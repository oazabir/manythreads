// The canary branch of the message box (clients/web/src/channels/Composer.tsx, PLAN P12-04) must never reach a production bundle: `VITE_MANYTHREADS_CANARY` is read
// at build time, so a build without it drops the branch and a build with it drops the box. This builds the client twice (a few minutes) and reads the files.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const web = fileURLToPath(new URL('..', import.meta.url));
const out: string[] = [];

function build(canary: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'mt-canary-build-'));
  out.push(dir);
  const env = { ...process.env, NODE_ENV: 'production' } as Record<string, string | undefined>;
  delete env['VITE_MANYTHREADS_CANARY'];
  if (canary !== undefined) env['VITE_MANYTHREADS_CANARY'] = canary;
  execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', dir, '--emptyOutDir', '--logLevel', 'error'], { cwd: web, env: env as NodeJS.ProcessEnv, stdio: 'pipe' });
  return dir;
}

function bundle(dir: string): string {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|html)$/.test(e.name)) files.push(p);
    }
  };
  walk(dir);
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
}

afterAll(() => {
  for (const d of out) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe('the canary build switch', () => {
  it('a production build has no canary branch and still has the message box', () => {
    const text = bundle(build(undefined));
    expect(text).not.toContain('hide-composer');
    expect(text).not.toContain('VITE_MANYTHREADS_CANARY');
    // `reply-composer` is the thread box's landmark, rendered only by the composer itself: its presence shows the box is in the bundle
    expect(text).toContain('reply-composer');
  }, 600_000);

  it('the canary build drops the message box (so the marker above means something)', () => {
    const text = bundle(build('hide-composer'));
    expect(text).not.toContain('reply-composer');
  }, 600_000);
});
