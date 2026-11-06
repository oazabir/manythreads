import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintSource, lintTree, type AllowEntry } from '../../../tools/lint-copy/check';

// Copy lint (P21-13): words a person should not have to read in the web client.
const root = join(__dirname, '..', '..', '..');
const rules = (src: string) => lintSource('x.tsx', src).map((f) => f.rule);
const jsx = (inner: string) => `export const A = () => <p>${inner}</p>;`;

describe('copy lint rules', () => {
  it('flags each kind of jargon', () => {
    expect(rules(jsx('Use `tag` here'))).toContain('R1');
    expect(rules(jsx('See pages/notes.md'))).toContain('R2');
    expect(rules(jsx('Open bots/ now'))).toContain('R2');
    expect(rules(jsx('The handover.mayTag list'))).toContain('R3');
    expect(rules(jsx('Set require_approval'))).toContain('R4');
    expect(rules(jsx('Edit TEAM.md'))).toContain('R5');
    expect(rules(jsx('Reach 10.0.0.5 or localhost:3000'))).toContain('R6');
    expect(rules(jsx('The loader and the broker'))).toContain('R7');
  });

  it('reads attributes, ternary branches and object labels', () => {
    expect(rules('export const A = () => <input placeholder="a_b_c" />;')).toContain('R4');
    expect(rules("export const A = ({x}: {x: boolean}) => <p>{x ? 'fine' : 'see BOT.md'}</p>;")).toContain('R5');
    expect(rules("export const o = { label: 'the outbox' };")).toContain('R7');
  });

  it('passes plain text, times and web addresses', () => {
    expect(rules(jsx('Mondays at 09:00. Visit api.github.com or Node.js docs.'))).toEqual([]);
    expect(rules('export const A = () => <p className="a_b.md" data-x="bots/y.md" />;')).toEqual([]);
  });

  it('catches a path or branch shown as it is (R8), not a plain name or an attribute', () => {
    expect(rules('export const A = ({ row }) => <span>{row.path}</span>;')).toEqual(['R8']);
    expect(rules('export const A = ({ card }) => <p>{card.branch}</p>;')).toEqual(['R8']);
    expect(rules('export const A = ({ row }) => <span title={row.path}>{friendlyPath(row.path)}</span>;')).toEqual([]);
    expect(rules('export const A = ({ row }) => <code>{row.path}</code>;')).toEqual([]);
  });

  it('skips code, pre and kbd', () => {
    expect(rules(jsx('<code>bots/x/BOT.md</code>'))).toEqual([]);
    expect(rules('export const A = () => <pre>TEAM.md {`handover.mayTag`}</pre>;')).toEqual([]);
    expect(rules('export const A = () => <kbd>outbox</kbd>;')).toEqual([]);
  });
});

describe('the real tree', () => {
  const allow = JSON.parse(readFileSync(join(root, 'tools', 'lint-copy', 'allowlist.json'), 'utf8')) as AllowEntry[];
  const result = lintTree(root, join(root, 'clients', 'web', 'src'), allow);

  it('has no jargon in visible text', () => {
    expect(result.findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.text}`)).toEqual([]);
  });

  it('keeps every allowlist entry used and explained', () => {
    expect(result.unused).toEqual([]);
    for (const a of allow) expect(a.why.trim().length).toBeGreaterThan(10);
  });
});
