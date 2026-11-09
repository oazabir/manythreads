// axe-core on the live page (PLAN P13-02): contrast and labels. Reports; precheck.ts decides what fails.
import { loadAxeBuilder, type PageLike } from './e2e-require.ts';

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
  /** The first three selectors. */
  targets: string[];
}

export interface AxeSummary {
  violations: AxeViolation[];
  /** `color-contrast` violations: elements below WCAG AA. */
  contrast: number;
  /** Controls without a name or label. */
  labels: number;
}

/** axe rules that are about a missing name or label. */
export const LABEL_RULES: readonly string[] = [
  'label',
  'button-name',
  'link-name',
  'input-button-name',
  'select-name',
  'image-alt',
  'aria-input-field-name',
  'aria-toggle-field-name',
  'aria-command-name',
  'aria-dialog-name',
  'aria-meter-name',
  'aria-progressbar-name',
  'aria-tooltip-name',
  'aria-treeitem-name',
  'frame-title',
];

/** Builds the summary from axe's raw violations (also used by the tests). */
export function summariseAxe(raw: Array<{ id: string; impact?: string | null; help: string; nodes: Array<{ target: unknown[] }> }>): AxeSummary {
  const violations: AxeViolation[] = raw.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 3).map((n) => n.target.map((t) => (typeof t === 'string' ? t : JSON.stringify(t))).join(' ')),
  }));
  const count = (ids: readonly string[]): number => violations.filter((v) => ids.includes(v.id)).reduce((sum, v) => sum + v.nodes, 0);
  return { violations, contrast: count(['color-contrast']), labels: count(LABEL_RULES) };
}

export async function runAxe(page: PageLike & object): Promise<AxeSummary> {
  const AxeBuilder = loadAxeBuilder();
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return summariseAxe(result.violations);
}
