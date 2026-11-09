// CHECKLIST.md is the PLAN's phase 13 text, word for word (PLAN P13-04: reviewers get it verbatim).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/e2e-require.ts';
import { CHECKLIST_FILE } from '../batches.ts';

const plan = readFileSync(join(REPO_ROOT, 'PLAN.md'), 'utf8').split('\n');
const checklist = readFileSync(CHECKLIST_FILE, 'utf8').split('\n');

/** The lines from the one that starts with `start` up to (not including) the next line that starts with `stop`. */
function slice(lines: string[], start: string, stop?: string): string[] {
  const from = lines.findIndex((l) => l.startsWith(start));
  if (from < 0) return [];
  const rest = lines.slice(from);
  const to = stop ? rest.findIndex((l, i) => i > 0 && l.startsWith(stop)) : rest.length;
  return rest.slice(0, to < 0 ? rest.length : to);
}

const rows = (lines: string[]): string[] => lines.filter((l) => l.startsWith('|'));

describe('CHECKLIST.md', () => {
  const planChecklist = slice(plan, '**The fixed checklist.**', '**Severity.**');
  const ownChecklist = slice(checklist, '**The fixed checklist.**', '**Severity.**');

  it('has the twelve category rows of the PLAN, equal line for line', () => {
    expect(rows(planChecklist)).toHaveLength(14); // header, rule, C01..C12
    expect(rows(ownChecklist)).toEqual(rows(planChecklist));
    expect(rows(ownChecklist).filter((r) => /^\| C\d\d /.test(r)).map((r) => r.slice(2, 5))).toEqual(
      Array.from({ length: 12 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('has the severity rubric of the PLAN verbatim', () => {
    const planSeverity = plan.find((l) => l.startsWith('**Severity.**'));
    expect(planSeverity).toBeTruthy();
    expect(checklist).toContain(planSeverity);
  });

  it('has the ISSUES.md row format of the PLAN verbatim: description, header, example row and rules', () => {
    const planFormat = slice(plan, '**`ISSUES.md` row format.**', '**Canary set.**').filter((l, i, all) => l !== '' || i < all.length - 1);
    const ownFormat = slice(checklist, '**`ISSUES.md` row format.**').filter((l, i, all) => l !== '' || i < all.length - 1);
    expect(planFormat.length).toBeGreaterThan(5);
    expect(ownFormat.slice(0, planFormat.length)).toEqual(planFormat);
  });

  it('does not hand the reviewer the canary set', () => {
    expect(checklist.join('\n')).not.toContain('Canary set');
  });

  it('carries a version line', () => {
    expect(checklist.some((l) => /^Version: \d+ /.test(l))).toBe(true);
  });
});
