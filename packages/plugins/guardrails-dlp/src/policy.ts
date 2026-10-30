import type { PluginTx } from '@manythreads/sdk';
import { DlpDetectorSetting, DlpRuleSetting, compileSpanPattern, type DlpCustomRule, type DlpPolicy, DLP_DETECTORS, type GateProgram } from '@manythreads/shared';
import { RULE_STEPS_PER_CALL, type CompiledRule, type DlpPolicySnapshot } from './dlp.ts';

// The workspace's data-loss policy, read from the two tables of migration 0001 and made ready to run. The check runs on every outgoing text of a
// workspace, so the read is cached for the length of the transaction it runs in (a run that checks forty strings reads the policy once).

export interface DetectorRow {
  detector: string;
  action: string;
  [key: string]: unknown;
}
export interface RuleRow {
  id: string;
  name: string;
  pattern: string;
  ignore_case: boolean;
  action: string;
  enabled: boolean;
  updated_at: Date | string;
  [key: string]: unknown;
}

export const RULE_COLUMNS = 'id, name, pattern, ignore_case, action, enabled, updated_at';

/** Compiled patterns by their source, so the same rule is not parsed again for every text; bounded so edits over weeks cannot grow it. */
const compiled = new Map<string, GateProgram | null>();
const COMPILED_MAX = 500;

/** A rule's program, or null when the pattern no longer compiles (it was accepted by an older engine); a rule that cannot run is skipped, never fatal. */
export function programOf(pattern: string, ignoreCase: boolean): GateProgram | null {
  const key = `${ignoreCase ? 'i' : 's'}:${pattern}`;
  const hit = compiled.get(key);
  if (hit !== undefined) return hit;
  const result = compileSpanPattern(pattern, ignoreCase);
  if (compiled.size >= COMPILED_MAX) compiled.clear();
  const program = result.ok ? result.program : null;
  compiled.set(key, program);
  return program;
}

export function snapshotOf(detectors: readonly DetectorRow[], rules: readonly RuleRow[]): DlpPolicySnapshot {
  const settings = new Map<string, DlpDetectorSetting>();
  for (const row of detectors) {
    const parsed = DlpDetectorSetting.safeParse(row.action);
    if (parsed.success) settings.set(row.detector, parsed.data);
  }
  const run: CompiledRule[] = [];
  for (const row of rules) {
    if (!row.enabled) continue;
    const action = DlpRuleSetting.safeParse(row.action);
    const program = programOf(row.pattern, row.ignore_case);
    if (action.success && program) run.push({ name: row.name, program, action: action.data });
  }
  // one budget per snapshot, and a snapshot is cached for one transaction: every text of one tool call draws on the same work allowance
  return { detectors: settings, rules: run, budget: { steps: RULE_STEPS_PER_CALL, exhausted: false } };
}

const cache = new WeakMap<object, Map<string, Promise<DlpPolicySnapshot>>>();

/** The policy of a workspace as `tx` sees it (RLS lets any member of the workspace and the system role read it). Cached per transaction. */
export function loadPolicy(tx: PluginTx, workspaceId: string): Promise<DlpPolicySnapshot> {
  let byWorkspace = cache.get(tx);
  if (!byWorkspace) {
    byWorkspace = new Map();
    cache.set(tx, byWorkspace);
  }
  let pending = byWorkspace.get(workspaceId);
  if (!pending) {
    pending = (async () => {
      const detectors = (await tx.query<DetectorRow>('SELECT detector, action FROM app.dlp_detectors WHERE workspace_id = $1::uuid', [workspaceId])).rows;
      const rules = (await tx.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM app.dlp_custom_rules WHERE workspace_id = $1::uuid AND enabled ORDER BY created_at, id`, [workspaceId])).rows;
      return snapshotOf(detectors, rules);
    })();
    byWorkspace.set(workspaceId, pending);
  }
  return pending;
}

export function toRule(row: RuleRow): DlpCustomRule {
  return {
    id: row.id,
    name: row.name,
    pattern: row.pattern,
    ignoreCase: row.ignore_case,
    action: DlpRuleSetting.parse(row.action),
    enabled: row.enabled,
    updatedAt: new Date(row.updated_at).toISOString(),
  } as DlpCustomRule;
}

/** The screen's view: every built-in detector with the admin's choice (or its default), and the custom rules. */
export function toPolicy(detectors: readonly DetectorRow[], rules: readonly RuleRow[]): DlpPolicy {
  const chosen = new Map<string, DlpDetectorSetting>();
  for (const row of detectors) {
    const parsed = DlpDetectorSetting.safeParse(row.action);
    if (parsed.success) chosen.set(row.detector, parsed.data);
  }
  return {
    detectors: DLP_DETECTORS.map((d) => ({
      name: d.name,
      label: d.label,
      description: d.description,
      group: d.group,
      action: chosen.get(d.name) ?? d.defaultSetting,
      custom: chosen.has(d.name),
    })),
    rules: rules.map(toRule),
  };
}
