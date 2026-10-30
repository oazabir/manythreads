import { conflict, forbidden, invalid, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  CreateDlpRuleRequest,
  DLP_CUSTOM_RULES_MAX,
  DLP_DETECTORS,
  DeleteDlpRuleResponse,
  DlpDetectorName,
  DlpPolicy,
  DlpRuleResponse,
  GATE_LIST_MAX_PROGRAM,
  LlmGuardPreset,
  SetDlpDetectorRequest,
  TestDlpRequest,
  TestDlpResponse,
  UpdateDlpRuleRequest,
  compileSpanPattern,
  createDlpRuleRoute,
  deleteDlpRuleRoute,
  getDlpPolicyRoute,
  setDlpDetectorRoute,
  testDlpRoute,
  updateDlpRuleRoute,
} from '@manythreads/shared';
import { z } from 'zod';
import { inspect } from './dlp.ts';
import { RULE_COLUMNS, programOf, snapshotOf, toPolicy, toRule, type DetectorRow, type RuleRow } from './policy.ts';

// Workspace > Data protection, the data-loss half (PLAN P10-04): read and change what the check does when a built-in detector fires, manage the custom
// rules, and try the policy on a piece of text. Workspace owners and admins only (the tables' policies say the same). A change is an audited event
// (`guardrails.policy.updated`) that names the detector or rule and never a pattern or any text; the test box judges the text in memory and forgets it.

async function requireWorkspaceAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can manage the data-loss policy.');
}

async function loadAll(tx: PluginTx, workspaceId: string): Promise<{ detectors: DetectorRow[]; rules: RuleRow[] }> {
  const detectors = (await tx.query<DetectorRow>('SELECT detector, action FROM app.dlp_detectors WHERE workspace_id = $1::uuid', [workspaceId])).rows;
  const rules = (await tx.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM app.dlp_custom_rules WHERE workspace_id = $1::uuid ORDER BY created_at, id`, [workspaceId])).rows;
  return { detectors, rules };
}

const NamedParams = z.object({ name: DlpDetectorName });
const RuleParams = z.object({ ruleId: z.uuid() });

export function registerRoutes(ctx: PluginContext): void {
  const emit = (tx: PluginTx, change: 'detector' | 'rule_added' | 'rule_changed' | 'rule_removed', subject: string): Promise<unknown> =>
    ctx.audit.emit(tx, {
      type: 'guardrails.policy.updated',
      workspaceId: tx.actor.workspaceId,
      kind: 'dlp',
      change,
      subject,
      teamId: null,
      changedBy: tx.actor.id,
      at: ctx.runtime.now().toISOString(),
    });

  /** The pattern is refused, in words the admin can act on, when it cannot be run safely or would match everywhere. */
  const compileOrRefuse = (pattern: string, ignoreCase: boolean): void => {
    const result = compileSpanPattern(pattern, ignoreCase);
    if (!result.ok) throw invalid(`This pattern cannot be used: ${result.reason}`);
  };

  /** All enabled rules together stay inside the engine's instruction budget, so one text never costs more than a bounded amount of work per rule set. */
  const checkBudget = async (tx: PluginTx, workspaceId: string, extra: { pattern: string; ignoreCase: boolean } | null, skipId: string | null): Promise<void> => {
    const rows = (await tx.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM app.dlp_custom_rules WHERE workspace_id = $1::uuid AND enabled AND ($2::uuid IS NULL OR id <> $2::uuid)`, [workspaceId, skipId])).rows;
    let total = extra ? (programOf(extra.pattern, extra.ignoreCase)?.insts.length ?? 0) : 0;
    for (const row of rows) total += programOf(row.pattern, row.ignore_case)?.insts.length ?? 0;
    if (total > GATE_LIST_MAX_PROGRAM) throw invalid(`Together the rules are too large (more than ${GATE_LIST_MAX_PROGRAM} steps); simplify or switch off some of them.`);
  };

  ctx.http.route({
    method: getDlpPolicyRoute.method,
    path: getDlpPolicyRoute.path,
    schema: { response: DlpPolicy },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { detectors, rules } = await loadAll(tx, tx.actor.workspaceId);
      return json(toPolicy(detectors, rules));
    }),
  });

  ctx.http.route({
    method: setDlpDetectorRoute.method,
    path: setDlpDetectorRoute.path,
    schema: { body: SetDlpDetectorRequest },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { name } = NamedParams.parse(req.params);
      const { action } = SetDlpDetectorRequest.parse(req.body);
      const workspaceId = tx.actor.workspaceId;
      const info = DLP_DETECTORS.find((d) => d.name === name);
      if (!info) throw notFound('There is no such detector.');
      const before = (await tx.query<{ action: string }>('SELECT action FROM app.dlp_detectors WHERE workspace_id = $1::uuid AND detector = $2', [workspaceId, name])).rows[0]?.action ?? info.defaultSetting;
      if (action === info.defaultSetting) {
        // Choosing the default again is "reset": the row goes, the detector follows its default.
        await tx.query('DELETE FROM app.dlp_detectors WHERE workspace_id = $1::uuid AND detector = $2', [workspaceId, name]);
      } else {
        await tx.query(
          `INSERT INTO app.dlp_detectors (workspace_id, detector, action, updated_by, updated_at) VALUES ($1::uuid, $2, $3, $4::uuid, now())
           ON CONFLICT (workspace_id, detector) DO UPDATE SET action = EXCLUDED.action, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [workspaceId, name, action, tx.actor.id],
        );
      }
      // Only a real change is a change: saying what is already so writes no event.
      if (before !== action) await emit(tx, 'detector', name);
      const { detectors, rules } = await loadAll(tx, workspaceId);
      return json(toPolicy(detectors, rules));
    }),
  });

  ctx.http.route({
    method: createDlpRuleRoute.method,
    path: createDlpRuleRoute.path,
    schema: { body: CreateDlpRuleRequest, response: DlpRuleResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const body = CreateDlpRuleRequest.parse(req.body);
      const workspaceId = tx.actor.workspaceId;
      compileOrRefuse(body.pattern, body.ignoreCase);
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [`dlp-rules:${workspaceId}`]);
      const count = Number((await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.dlp_custom_rules WHERE workspace_id = $1::uuid', [workspaceId])).rows[0]?.n ?? 0);
      if (count >= DLP_CUSTOM_RULES_MAX) throw conflict(`A workspace can have at most ${DLP_CUSTOM_RULES_MAX} custom rules; remove one first.`);
      if (body.enabled) await checkBudget(tx, workspaceId, body, null);
      const inserted = await tx.query<RuleRow>(
        `INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern, ignore_case, action, enabled, updated_by) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)
         ON CONFLICT (workspace_id, name) DO NOTHING RETURNING ${RULE_COLUMNS}`,
        [workspaceId, body.name, body.pattern, body.ignoreCase, body.action, body.enabled, tx.actor.id],
      );
      const row = inserted.rows[0];
      if (!row) throw conflict('A rule with this name already exists.');
      await emit(tx, 'rule_added', row.name);
      return json({ rule: toRule(row) }, 201);
    }),
  });

  ctx.http.route({
    method: updateDlpRuleRoute.method,
    path: updateDlpRuleRoute.path,
    schema: { body: UpdateDlpRuleRequest, response: DlpRuleResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { ruleId } = RuleParams.parse(req.params);
      const body = UpdateDlpRuleRequest.parse(req.body);
      const workspaceId = tx.actor.workspaceId;
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [`dlp-rules:${workspaceId}`]);
      const current = (await tx.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM app.dlp_custom_rules WHERE id = $1::uuid AND workspace_id = $2::uuid`, [ruleId, workspaceId])).rows[0];
      if (!current) throw notFound('There is no such rule.');
      const next = {
        name: body.name ?? current.name,
        pattern: body.pattern ?? current.pattern,
        ignoreCase: body.ignoreCase ?? current.ignore_case,
        action: body.action ?? current.action,
        enabled: body.enabled ?? current.enabled,
      };
      if (next.pattern !== current.pattern || next.ignoreCase !== current.ignore_case) compileOrRefuse(next.pattern, next.ignoreCase);
      if (next.enabled) await checkBudget(tx, workspaceId, next, ruleId);
      const unchanged = next.name === current.name && next.pattern === current.pattern && next.ignoreCase === current.ignore_case && next.action === current.action && next.enabled === current.enabled;
      if (unchanged) return json({ rule: toRule(current) });
      const updated = await tx
        .query<RuleRow>(
          `UPDATE app.dlp_custom_rules SET name = $3, pattern = $4, ignore_case = $5, action = $6, enabled = $7, updated_by = $8::uuid, updated_at = now()
           WHERE id = $1::uuid AND workspace_id = $2::uuid RETURNING ${RULE_COLUMNS}`,
          [ruleId, workspaceId, next.name, next.pattern, next.ignoreCase, next.action, next.enabled, tx.actor.id],
        )
        .catch((err: { code?: string }) => {
          if (err.code === '23505') throw conflict('A rule with this name already exists.');
          throw err;
        });
      const row = updated.rows[0] as RuleRow;
      await emit(tx, 'rule_changed', row.name);
      return json({ rule: toRule(row) });
    }),
  });

  ctx.http.route({
    method: deleteDlpRuleRoute.method,
    path: deleteDlpRuleRoute.path,
    schema: { response: DeleteDlpRuleResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { ruleId } = RuleParams.parse(req.params);
      const removed = await tx.query<{ name: string }>('DELETE FROM app.dlp_custom_rules WHERE id = $1::uuid AND workspace_id = $2::uuid RETURNING name', [ruleId, tx.actor.workspaceId]);
      const name = removed.rows[0]?.name;
      if (!name) throw notFound('There is no such rule.');
      await emit(tx, 'rule_removed', name);
      return json({ ok: true as const });
    }),
  });

  // The test box. The text is judged in memory under the saved policy (plus the unsaved rule, if one is sent) and is gone when the answer is sent:
  // nothing is stored, logged or put in an event. Rate-limited because every call runs the whole rule set over up to 20,000 characters.
  ctx.http.route({
    method: testDlpRoute.method,
    path: testDlpRoute.path,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { body: TestDlpRequest, response: TestDlpResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const body = TestDlpRequest.parse(req.body);
      const { detectors, rules } = await loadAll(tx, tx.actor.workspaceId);
      const saved = snapshotOf(detectors, rules);
      let snapshot = saved;
      if (body.rule) {
        const compiled = compileSpanPattern(body.rule.pattern, body.rule.ignoreCase);
        if (!compiled.ok) throw invalid(`This pattern cannot be used: ${compiled.reason}`);
        snapshot = { detectors: saved.detectors, rules: [...saved.rules, { name: body.rule.name, program: compiled.program, action: body.rule.action }] };
      }
      const preset = LlmGuardPreset.parse(body.preset);
      const result = inspect(body.text, preset, 'preset', snapshot);
      const counts = new Map<string, number>();
      for (const finding of result.findings) counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1);
      return json({ outcome: result.outcome, text: result.text, findings: [...counts].map(([rule, count]) => ({ rule, count })) });
    }),
  });
}
