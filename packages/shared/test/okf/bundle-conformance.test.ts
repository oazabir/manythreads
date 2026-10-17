import { describe, expect, it } from 'vitest';
import {
  parseConcept,
  parseIndex,
  parseLog,
  renderBundleIndex,
  renderBundleLog,
  renderIndex,
  renderLog,
  serializeConcept,
  trustTier,
  isStale,
} from '../../src/okf/index.ts';
import { toMemoryConcept } from '../../src/entities/memory.ts';

// PLAN P5-24: the OKF spec's own income-statement bundle (Appendix A) parses and round-trips.
// Faithful in shape (narrative Metric + two Attested Computations, sources with author/usage_count/
// last_modified/usage_window, generated/verified/stale_after, actor convention), trimmed in prose.

const REVENUE = `---
type: Attested Computation
title: Revenue computation
description: Sanctioned revenue calculation for a fiscal year.
tags: [finance, revenue]
status: stable
sources:
  - resource: references/policies/revenue-policy.md
    id: revenue-policy
    title: Revenue recognition policy
  - resource: dashboards/exec-revenue
    id: exec-dashboard
    title: Executive revenue dashboard
    author: process:finance-nightly
    usage_count: 42
    last_modified: 2026-09-30T00:00:00+00:00
    usage_window:
      from: 2026-07-01T00:00:00+00:00
      to: 2026-09-30T00:00:00+00:00
generated:
  by: reference_agent/gemini-2.5-pro
  at: 2026-10-01T00:00:00+00:00
verified:
  by: human:ahormati
  at: 2026-10-02T00:00:00+00:00
---

# Revenue

Revenue for the year, computed on BigQuery. See [runbook](references/skills/run-on-bq.md).
`;

const PROFIT = `---
type: Attested Computation
title: Profit computation
tags: [finance, profit]
status: stable
sources:
  - resource: computations/revenue.md
    id: revenue
  - resource: models/mart-profit
    id: profit-mart
    author: process:finance-nightly
    usage_count: 7
    last_modified: 2026-09-29T00:00:00+00:00
generated:
  by: process:finance-nightly
  at: 2026-09-30T00:00:00+00:00
verified:
  - by: process:finance-nightly
    at: 2026-09-30T01:00:00+00:00
stale_after: 2020-01-01T00:00:00+00:00
---

# Profit

Profit for the year and segment, computed with dbt.
`;

const INCOME = `---
type: Metric
title: Income statement
description: Recognized revenue and gross profit for the fiscal year.
usage_window:
  from: 2026-07-01T00:00:00+00:00
  to: 2026-09-30T00:00:00+00:00
sources:
  - resource: computations/revenue.md
    id: revenue
    title: Revenue computation
  - resource: computations/profit.md
    id: profit
    title: Profit computation
generated:
  by: reference_agent/gemini-2.5-pro
  at: 2026-10-01T00:00:00+00:00
---

# Income statement

Narrates [revenue](../computations/revenue.md) and [profit](../computations/profit.md).[^revenue]

[^revenue]: per claim keyed to sources.
`;

describe('OKF income-statement bundle (spec Appendix A)', () => {
  it('parses every file, with sources, actors and trust', () => {
    const revenue = parseConcept(REVENUE);
    expect(revenue.ok).toBe(true);
    if (!revenue.ok) return;
    expect(revenue.frontmatter.type).toBe('Attested Computation');
    expect(revenue.frontmatter.sources?.length).toBe(2);
    expect(revenue.frontmatter.sources?.[1]).toMatchObject({
      resource: 'dashboards/exec-revenue',
      author: 'process:finance-nightly',
      usage_count: 42,
      usage_window: { from: '2026-07-01T00:00:00+00:00' },
    });
    expect(trustTier(revenue.frontmatter)).toBe('human-reviewed');

    const profit = parseConcept(PROFIT);
    expect(profit.ok).toBe(true);
    if (!profit.ok) return;
    expect(trustTier(profit.frontmatter)).toBe('machine-confirmed');
    expect(isStale(profit.frontmatter, new Date('2026-10-13T00:00:00Z'))).toBe(true);

    const income = parseConcept(INCOME);
    expect(income.ok).toBe(true);
    if (!income.ok) return;
    expect(income.frontmatter.usage_window?.from).toBe('2026-07-01T00:00:00+00:00');
    expect(trustTier(income.frontmatter)).toBe('unverified');
  });

  it('round-trips every file through serialize/parse', () => {
    for (const text of [REVENUE, PROFIT, INCOME]) {
      const parsed = parseConcept(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const again = parseConcept(serializeConcept(parsed.frontmatter as Record<string, unknown>, parsed.body));
      expect(again).toMatchObject({ ok: true, frontmatter: parsed.frontmatter });
    }
  });

  it('builds MemoryConcepts with tier, stale and deprecated flags', () => {
    const now = new Date('2026-10-13T00:00:00Z');
    const parsed = parseConcept(PROFIT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const concept = toMemoryConcept('memory/computations/profit.md', parsed.frontmatter, parsed.body, now);
    expect(concept).toMatchObject({ path: 'memory/computations/profit.md', trustTier: 'machine-confirmed', stale: true, deprecated: false });
  });

  it('parses and renders index and log files', () => {
    const indexText = '# Metrics\n\n* [Revenue](metrics/revenue.md) - Recognized revenue for a fiscal year.\n\n# Computations\n\n* [Revenue computation](computations/revenue.md) - Sanctioned revenue calculation.\n';
    const index = parseIndex(indexText);
    expect(index.sections).toEqual(['Metrics', 'Computations']);
    expect(index.entries.length).toBe(2);
    expect(renderIndex(index)).toBe(indexText);

    const logText = renderBundleLog([
      { date: '2026-10-13', text: 'newest' },
      { date: '2026-10-11', text: 'older' },
    ]);
    expect(parseLog(logText)).toEqual([
      { date: '2026-10-13', text: 'newest' },
      { date: '2026-10-11', text: 'older' },
    ]);
    expect(renderLog(parseLog(logText))).toBe(logText);
    expect(renderBundleIndex()).toContain('okf_version');
  });

  it('refuses a bare-string actor and a bad source, naming the field', () => {
    expect(parseConcept('---\ntype: Fact\ngenerated:\n  by: nobody-in-particular\n---\nbody\n')).toMatchObject({ ok: false });
    const bad = parseConcept('---\ntype: Fact\nsources:\n  - title: no resource here\n---\nbody\n');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/sources/);
  });
});

describe('hostile frontmatter (40 inputs, linear)', () => {
  const framed = (inner: string): string => `---\ntype: Fact\n${inner}---\nbody\n`;
  const cases: Array<[string, (n: number) => string]> = [
    ['nested brackets', (n) => framed(`x: ${'['.repeat(n)}\n`)],
    ['nested braces', (n) => framed(`x: ${'{a: '.repeat(n / 4)}\n`)],
    ['anchors run', (n) => framed('a: &x 1\n'.repeat(n / 8))],
    ['billion-laughs shape', (n) => framed(`a: &a [x, x]\nb: &b [*a, *a]\nc: &c [*b, *b]\nd: &d [*c, *c]\ne: &e [*d, *d]\nf: [*e, *e]\n${'#'.repeat(n)}\n`)],
    ['many keys', (n) => framed(Array.from({ length: n / 10 }, (_, i) => `k${i}: v${i}\n`).join(''))],
    ['long quoted string', (n) => framed(`note: "${'a\\"'.repeat(n / 3)}"\n`)],
    ['deep block nesting', (n) => framed(`${'level:\n  '.repeat(n / 10)}x: 1\n`)],
    ['many list items', (n) => framed(`tags: [${Array.from({ length: n / 8 }, (_, i) => `t${i}`).join(', ')}]\n`)],
    ['long single line', (n) => framed(`note: ${'z'.repeat(n)}\n`)],
    ['many sources', (n) => framed(`sources:\n${Array.from({ length: n / 40 }, (_, i) => `  - resource: refs/${i}.md\n`).join('')}`)],
    ['many tags', (n) => framed(`tags: [${Array.from({ length: n / 6 }, () => 'ab').join(', ')}]\n`)],
    ['flow commas', (n) => framed(`x: [${','.repeat(n)}]\n`)],
    ['flow colons', (n) => framed(`x: {${'a: 1, '.repeat(n / 8)}}\n`)],
    ['comment lines', (n) => framed(`${'# note\n'.repeat(n / 8)}`)],
    ['empty mappings', (n) => framed(`${'k: {}\n'.repeat(n / 8)}`)],
    ['empty sequences', (n) => framed(`${'k: []\n'.repeat(n / 8)}`)],
    ['multiline literal', (n) => framed(`note: |\n${'  line\n'.repeat(n / 8)}`)],
    ['folded literal', (n) => framed(`note: >\n${'  line\n'.repeat(n / 8)}`)],
    ['quoted keys', (n) => framed(Array.from({ length: n / 12 }, (_, i) => `"k${i}": v\n`).join(''))],
    ['single-quoted run', (n) => framed(`note: '${'q'.repeat(n)}'\n`)],
    ['double anchors', (n) => framed(Array.from({ length: n / 12 }, (_, i) => `a${i}: &x${i} 1\n`).join(''))],
    ['alias attempts', (n) => framed(`a: &x 1\n${'b: *x\n'.repeat(n / 8)}`)],
    ['merge keys', (n) => framed(`${'<<: *x\n'.repeat(n / 8)}`)],
    ['explicit doc ends', (n) => framed(`${'k: v\n...\n'.repeat(n / 8)}`)],
    ['directives', (n) => framed(`${'%YAML 1.2\n'.repeat(n / 10)}`)],
    ['tab indentation', (n) => framed(`${'\tk: v\n'.repeat(n / 6)}`)],
    ['trailing spaces', (n) => framed(`${'k: v   \n'.repeat(n / 8)}`)],
    ['unicode keys', (n) => framed(Array.from({ length: n / 12 }, (_, i) => `clé${i}: v\n`).join(''))],
    ['emoji values', (n) => framed(`note: ${'🙂'.repeat(n / 4)}\n`)],
    ['crlf lines', (n) => framed(Array.from({ length: n / 8 }, () => 'k: v\r\n').join(''))],
    ['very long key', (n) => framed(`${'k'.repeat(n)}: v\n`)],
    ['very long tag', (n) => framed(`tags: [${'t'.repeat(n)}]\n`)],
    ['nested flow in sources', (n) => framed(`sources:\n  - resource: [${'['.repeat(n / 2)}]\n`)],
    ['deep verified list', (n) => framed(`verified:\n${'  - by: process:x\n'.repeat(n / 20)}`)],
    ['wide mapping line', (n) => framed(`x: {${Array.from({ length: n / 10 }, (_, i) => `k${i}: v${i}`).join(', ')}}\n`)],
    ['repeated type key', (n) => framed(`${'type: Fact\n'.repeat(n / 12)}`)],
    ['nullish values', (n) => framed(`${'k: ~\n'.repeat(n / 6)}`)],
    ['bool-ish values', (n) => framed(`${'k: yes\n'.repeat(n / 8)}`)],
    ['float-ish values', (n) => framed(`${'k: 1.5\n'.repeat(n / 8)}`)],
    ['date-ish values', (n) => framed(`${'k: 2026-10-13\n'.repeat(n / 12)}`)],
  ];
  it.each(cases)('%s stays linear', (_name, build) => {
    const small = build(4000);
    const big = build(16000);
    const t0 = performance.now();
    parseConcept(small);
    const t1 = performance.now();
    parseConcept(big);
    const t2 = performance.now();
    const smallMs = Math.max(t1 - t0, 20);
    const bigMs = t2 - t1;
    expect(bigMs).toBeLessThan(Math.max(smallMs * 10, 1000));
    expect(bigMs).toBeLessThan(2000);
  });
});
