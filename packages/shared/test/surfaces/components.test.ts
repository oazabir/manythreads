import { describe, expect, it } from 'vitest';
import { DIFF_MAX_CHARS, DIFF_MAX_LINES, SURFACE_REGISTRY, parseSurface, type SurfaceNode } from '../../src/index.ts';

// The primitives and the manythreads parts (PLAN P9-05): each is checked by its own schema, through the same checker a bot's text goes through.

const props = (name: string, raw: Record<string, unknown>): { ok: boolean; why: string } => {
  const r = SURFACE_REGISTRY.get(name)!.props.safeParse(raw);
  return { ok: r.success, why: r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
};
const good = (name: string, raw: Record<string, unknown>): void => expect(props(name, raw), `${name} ${JSON.stringify(raw).slice(0, 80)}`).toMatchObject({ ok: true });
const bad = (name: string, raw: Record<string, unknown>, why?: RegExp): void => {
  const r = props(name, raw);
  expect(r.ok, `${name} ${JSON.stringify(raw).slice(0, 80)}`).toBe(false);
  if (why) expect(r.why).toMatch(why);
};
const root = (line: string): SurfaceNode => parseSurface(`root = ${line}\n`, SURFACE_REGISTRY).root!;

describe('layout parts', () => {
  it('Row and Grid take a gap, Row an alignment and Grid 1 to 4 columns', () => {
    good('Row', { gap: 'small', align: 'between' });
    good('Row', {});
    bad('Row', { align: 'stretch' });
    bad('Row', { gap: 'huge' });
    good('Grid', { columns: 4, gap: 'none' });
    bad('Grid', { columns: 0 });
    bad('Grid', { columns: 5 });
    bad('Grid', { columns: 2.5 });
  });
  it('children may be other parts, and only parts', () => {
    const t = parseSurface('root = Row([a, b], "small")\na = Badge("Open")\nb = Divider()\n', SURFACE_REGISTRY);
    expect(t.problems).toEqual([]);
    expect(t.root?.kind === 'component' && t.root.children.map((c) => (c.kind === 'component' ? c.name : c.kind))).toEqual(['Badge', 'Divider']);
    const plain = root('Grid(["just text"])');
    expect(plain.kind === 'component' && plain.children[0]?.kind).toBe('rejected');
  });
  it('Divider takes nothing', () => {
    expect(root('Divider()').kind).toBe('component');
    expect(root('Divider(1)')).toMatchObject({ kind: 'rejected', code: 'invalid_props' });
  });
});

describe('Stat, Badge, Callout, List', () => {
  it('Stat takes a label and a text or number', () => {
    good('Stat', { label: 'Sales', value: 'USD 4.2k', delta: '+4%', tone: 'good' });
    good('Stat', { label: 'Sales', value: 42 });
    bad('Stat', { label: 'Sales' });
    bad('Stat', { label: '', value: 1 });
    bad('Stat', { label: 'x', value: Number.POSITIVE_INFINITY });
    bad('Stat', { label: 'x', value: 'y'.repeat(41) });
    bad('Stat', { label: 'x', value: 1, tone: 'purple' });
  });
  it('Badge', () => {
    good('Badge', { text: 'Late', tone: 'bad' });
    bad('Badge', { text: '' });
    bad('Badge', { text: 'x'.repeat(41) });
    bad('Badge', { text: 'x', tone: 'loud' });
  });
  it('Callout', () => {
    good('Callout', { text: 'Heads up', tone: 'warn', title: 'Note' });
    bad('Callout', { text: '' });
    bad('Callout', { text: 'x'.repeat(2001) });
    bad('Callout', { text: 'x', title: 'y'.repeat(121) });
  });
  it('List', () => {
    good('List', { items: ['a', 'b'], ordered: true });
    bad('List', { items: [] });
    bad('List', { items: ['a', ''] });
    bad('List', { items: Array.from({ length: 101 }, () => 'a') });
    bad('List', { items: [1, 2] });
    bad('List', { items: ['a'], ordered: 'yes' });
  });
});

describe('Table', () => {
  it('takes columns and rows of plain values', () => {
    good('Table', { columns: ['Name', 'Qty'], rows: [['Pens', 4], ['Ink', null], ['Paper', true]], caption: 'Stock' });
    good('Table', { columns: ['A'], rows: [] });
    good('Table', { columns: ['A', 'B'], rows: [['short row']] });
  });
  it('refuses too many columns or rows, a row wider than the columns, long cells and nested values', () => {
    bad('Table', { columns: [], rows: [] });
    bad('Table', { columns: Array.from({ length: 11 }, (_, i) => `c${i}`), rows: [] });
    bad('Table', { columns: ['A'], rows: Array.from({ length: 51 }, () => ['x']) });
    good('Table', { columns: ['A'], rows: Array.from({ length: 50 }, () => ['x']) });
    bad('Table', { columns: ['A'], rows: [['x', 'y']] }, /more values than there are columns/);
    bad('Table', { columns: ['A'], rows: [['x'.repeat(301)]] });
    bad('Table', { columns: ['A'], rows: [[{ a: 1 }]] });
    bad('Table', { columns: ['A'], rows: [['x']], caption: '' });
  });
  it('a table that is too big in all is refused by the checker budget', () => {
    const cell = 'x'.repeat(300);
    const row = `[${Array.from({ length: 10 }, () => `"${cell}"`).join(', ')}]`;
    const rows = Array.from({ length: 50 }, () => row).join(', ');
    const cols = Array.from({ length: 10 }, (_, i) => `"c${i}"`).join(', ');
    expect(root(`Table([${cols}], [${rows}])`)).toMatchObject({ kind: 'rejected', code: 'too_large' });
  });
});

describe('Chart', () => {
  it('takes a kind, one label for each number, and numbers', () => {
    good('Chart', { kind: 'bar', labels: ['Mon', 'Tue'], values: [3, -1.5], title: 'Visits', unit: 'k' });
    good('Chart', { kind: 'line', labels: ['a'], values: [0] });
  });
  it('refuses another kind, a count mismatch, non-numbers, huge numbers and too many points', () => {
    bad('Chart', { kind: 'pie', labels: ['a'], values: [1] });
    bad('Chart', { kind: 'bar', labels: ['a', 'b'], values: [1] }, /one label for each value/);
    bad('Chart', { kind: 'bar', labels: ['a'], values: ['1'] });
    bad('Chart', { kind: 'bar', labels: ['a'], values: [1e13] });
    bad('Chart', { kind: 'bar', labels: ['a'], values: [Number.NaN] });
    bad('Chart', { kind: 'bar', labels: [], values: [] });
    const many = Array.from({ length: 41 }, (_, i) => i);
    bad('Chart', { kind: 'line', labels: many.map(String), values: many });
    bad('Chart', { kind: 'bar', labels: ['x'.repeat(61)], values: [1] });
  });
});

describe('Button (P9-04)', () => {
  it('takes a label and a tone, and declares one empty press event', () => {
    good('Button', { label: 'Approve', tone: 'primary' });
    good('Button', { label: 'Next' });
    bad('Button', {});
    bad('Button', { label: '' });
    bad('Button', { label: 'x'.repeat(81) });
    bad('Button', { label: 'Go', tone: 'huge' });
    expect(Object.keys(SURFACE_REGISTRY.get('Button')!.events)).toEqual(['press']);
  });
  it('is the only part that can be answered: no other part declares an event', () => {
    for (const n of SURFACE_REGISTRY.names()) {
      if (n !== 'Button') expect(Object.keys(SURFACE_REGISTRY.get(n)!.events), n).toEqual([]);
    }
  });
});

describe('Code', () => {
  it('takes text and a short language name', () => {
    good('Code', { code: 'const a = 1;', language: 'ts' });
    good('Code', { code: 'x', language: 'c++' });
    bad('Code', { code: '' });
    bad('Code', { code: 'x'.repeat(8001) });
    bad('Code', { code: 'x', language: 'TS' });
    bad('Code', { code: 'x', language: '"><script>' });
  });
});

describe('the manythreads parts take ids, never addresses', () => {
  it('EntityCard', () => {
    good('EntityCard', { entityType: 'task', id: 'a1b2-c3', label: 'Fix the login', summary: 'Due Friday' });
    bad('EntityCard', { entityType: 'Task', id: 'a1', label: 'x' });
    bad('EntityCard', { entityType: 'task', id: 'https://evil.example/x.png', label: 'x' });
    bad('EntityCard', { entityType: 'task', id: '../etc/passwd', label: 'x' });
    bad('EntityCard', { entityType: 'task', id: 'a1', label: '' });
    bad('EntityCard', { entityType: 'task', id: 'a1', label: 'x', summary: 'y'.repeat(301) });
  });
  it('PersonChip and ChannelLink', () => {
    for (const name of ['PersonChip', 'ChannelLink']) {
      good(name, { id: '7f3c9e1a-0000-4000-8000-000000000001', label: 'Sam' });
      bad(name, { id: '', label: 'Sam' });
      bad(name, { id: 'a b', label: 'Sam' });
      bad(name, { id: '<img src=x onerror=1>', label: 'Sam' });
      bad(name, { id: 'javascript:alert(1)/x', label: 'Sam' });
      bad(name, { id: 'ok', label: '' });
      bad(name, { id: 'ok', label: 'x'.repeat(121) });
      bad(name, { id: 'x'.repeat(81), label: 'Sam' });
    }
  });
  it('ApprovalCard shows a request and has no way to decide it', () => {
    good('ApprovalCard', { approvalId: 'ap_123', title: 'Send the mail', summary: 'To: sam' });
    bad('ApprovalCard', { title: 'x' });
    bad('ApprovalCard', { approvalId: 'a b', title: 'x' });
    bad('ApprovalCard', { approvalId: 'ap1', title: '' });
    bad('ApprovalCard', { approvalId: 'ap1', title: 'x', summary: 'y'.repeat(1001) });
    expect(SURFACE_REGISTRY.get('ApprovalCard')!.args).not.toContain('event');
  });
});

describe('DiffView', () => {
  const sample = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,2 @@', ' same', '-old', '+new'].join('\n');
  it('takes a unified diff and a title', () => {
    good('DiffView', { diff: sample, title: 'x.ts' });
  });
  it('refuses an empty diff, one with too many characters or lines, and a long title', () => {
    bad('DiffView', { diff: '' });
    bad('DiffView', { diff: '+'.repeat(DIFF_MAX_CHARS + 1) });
    good('DiffView', { diff: '+'.repeat(DIFF_MAX_CHARS) });
    bad('DiffView', { diff: Array.from({ length: DIFF_MAX_LINES + 1 }, () => '+a').join('\n') }, /more than/);
    good('DiffView', { diff: Array.from({ length: DIFF_MAX_LINES }, () => '+a').join('\n') });
    bad('DiffView', { diff: sample, title: 'x'.repeat(201) });
    bad('DiffView', { diff: 42 });
  });
  it('is read from a diff written in the bot text', () => {
    const n = root('DiffView("@@ -1 +1 @@\\n-a\\n+b", "f.ts")');
    expect(n.kind === 'component' && n.props).toEqual({ diff: '@@ -1 +1 @@\n-a\n+b', title: 'f.ts' });
  });
});

describe('every part, through the checker', () => {
  it('a bad value in one part is refused and its neighbours stay', () => {
    const t = parseSurface('root = Stack([a, b, c])\na = Badge("ok")\nb = Chart("pie", ["a"], [1])\nc = Divider()\n', SURFACE_REGISTRY);
    const kids = t.root?.kind === 'component' ? t.root.children : [];
    expect(kids.map((k) => k.kind)).toEqual(['component', 'rejected', 'component']);
    expect(t.problems.map((p) => p.code)).toEqual(['invalid_props']);
  });
  it('each part has a plain-language summary', () => {
    for (const n of SURFACE_REGISTRY.names()) expect(SURFACE_REGISTRY.get(n)!.summary.length, n).toBeGreaterThan(10);
  });
});
