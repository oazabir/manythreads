import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, failures, judge, type AllowEntry } from './check.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const css = readFileSync(join(root, 'clients', 'web', 'src', 'styles', 'tokens.css'), 'utf8');
const allowPath = join(here, 'allow.json');
const allow = existsSync(allowPath) ? (JSON.parse(readFileSync(allowPath, 'utf8')) as AllowEntry[]) : [];

const { failing, unused } = judge([...failures(css, 'light'), ...failures(css, 'dark')], allow);
for (const f of failing) console.log(describe(f));
for (const a of unused) console.log(`tools/lint-contrast/allow.json: unused entry ${a.theme} --${a.fg} on --${a.bg}`);
if (failing.length > 0 || unused.length > 0) process.exit(1);
