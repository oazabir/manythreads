import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P27-17: the texts every template ships must read the same on a customer's machine as on ours. A bot told to deploy to `test-manythreads` or to
// check `test.<our host>` would look for a namespace and an address a customer does not have. The deploy target and the address come from the
// project's `deploy/preview/README.md`, from the kubeconfig's own comment lines and from the "Where you run" text, never from these files.
// Pure file reading: no database, so it runs anywhere.

const TEMPLATES_DIR = fileURLToPath(new URL('../../../../templates/', import.meta.url));

/** Names that belong to our own devbox. */
const DEVBOX_NAMES: Array<[string, RegExp]> = [
  ['the devbox preview namespace', /test-manythreads/i],
  ['the devbox preview host', /test\.manythreads/i],
  ['the live site or any kahf host', /kahf\.to/i],
  ['the CI namespace', /manythreads-ci\b/i],
  ['the private devbox registry', /registry\.local/i],
];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(md|ya?ml|json|mjs|js|ts|txt|html|css|dockerfile)$/i.test(e.name) || e.name === 'Dockerfile') out.push(p);
  }
  return out;
}

describe('template texts are install-neutral (P27-17)', () => {
  it('no file under templates/ names the devbox', async () => {
    const files = await walk(TEMPLATES_DIR);
    expect(files.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      for (const [what, re] of DEVBOX_NAMES) if (re.test(text)) hits.push(`${f.slice(TEMPLATES_DIR.length)}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  it('the Deployer reads its target and address from the project README and the kubeconfig', async () => {
    const text = await readFile(join(TEMPLATES_DIR, 'engineering/bots/deployer/BOT.md'), 'utf8');
    expect(text).toContain('deploy/preview/README.md');
    expect(text).toContain('/apps/<team>/<app>/');
    expect(text).toMatch(/kubeconfig/);
  });

  it('the Web smoke tester tests the address on the card, which may be a sub-path, and copes with an app that has no sign-in', async () => {
    const text = await readFile(join(TEMPLATES_DIR, 'engineering/bots/web-smoke-tester/BOT.md'), 'utf8');
    expect(text).toContain('/apps/<team>/<app>/');
    expect(text).toMatch(/no sign-in/);
  });
});
