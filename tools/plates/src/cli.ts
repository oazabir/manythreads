import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// `pnpm vt` = playwright test -c e2e/playwright.config.ts e2e/visual (desktop project only).
// Run from e2e/ so the same @playwright/test copy loads the config and the specs.
const e2e = resolve(dirname(fileURLToPath(import.meta.url)), '../../../e2e');
const update = process.argv.includes('--update');
const args = ['exec', 'playwright', 'test', '-c', 'playwright.config.ts', 'visual', '--project=desktop'];
if (update) args.push('--update-snapshots');
const r = spawnSync('pnpm', args, { stdio: 'inherit', cwd: e2e });
process.exit(r.status ?? 1);
