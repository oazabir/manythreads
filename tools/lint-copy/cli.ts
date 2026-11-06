import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintTree, type AllowEntry } from './check.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const allow = JSON.parse(readFileSync(join(here, 'allowlist.json'), 'utf8')) as AllowEntry[];
const { findings, unused } = lintTree(root, join(root, 'clients', 'web', 'src'), allow);
for (const f of findings) console.log(`${f.file}:${f.line} ${f.rule} ${f.text}`);
for (const a of unused) console.log(`tools/lint-copy/allowlist.json: unused entry ${a.file} "${a.text}"`);
if (findings.length > 0 || unused.length > 0) process.exit(1);
