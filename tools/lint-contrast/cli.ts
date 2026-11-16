import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allFailures, describe, judge, PALETTES, type AllowEntry } from './check.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const styles = join(root, 'clients', 'web', 'src', 'styles');
// tokens.css (the classic palette and the shared block) first, then each palette's generated file: the order the app loads them in
const css = [readFileSync(join(styles, 'tokens.css'), 'utf8'), ...PALETTES.filter((p) => p !== 'classic').map((p) => readFileSync(join(styles, 'themes', `${p}.css`), 'utf8'))].join('\n');
const allowPath = join(here, 'allow.json');
const allow = existsSync(allowPath) ? (JSON.parse(readFileSync(allowPath, 'utf8')) as AllowEntry[]) : [];

const { failing, unused } = judge(allFailures(css), allow);
for (const f of failing) console.log(describe(f));
for (const a of unused) console.log(`tools/lint-contrast/allow.json: unused entry ${a.palette ?? 'classic'}/${a.theme} --${a.fg} on --${a.bg}`);
if (failing.length > 0 || unused.length > 0) process.exit(1);
