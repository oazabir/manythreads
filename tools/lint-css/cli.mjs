// lint-css — stylelint on the CSS files git knows (tracked, plus new ones not ignored), never on a glob.
// Why: `stylelint "**/*.css"` walks every folder, node_modules included (thousands of CSS files behind pnpm's links), before any ignore applies;
// on this machine it ran for 25 minutes and died with "JavaScript heap out of memory". A list of files from git takes about five seconds.
import { execFileSync, spawnSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.css'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean);
if (files.length === 0) process.exit(0);
const r = spawnSync('pnpm', ['exec', 'stylelint', ...files], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
