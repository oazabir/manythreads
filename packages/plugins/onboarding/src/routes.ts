import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  LaunchOnboardingRequest,
  OnboardingMarkKind,
  OnboardingState,
  OnboardingStateResponse,
  OnboardingStepPathParams,
  SetOnboardingMarkRequest,
  clearOnboardingMarkRoute,
  dismissOnboardingRoute,
  getOnboardingRoute,
  launchOnboardingRoute,
  setOnboardingMarkRoute,
  type OnboardingMarkStep,
} from '@manythreads/shared';
import { conflict, json, requireWorkspaceAdmin, route } from './http.ts';

// Workspace → Setup (PLAN P10-01). See docs/plugins/onboarding.md. Every route is for workspace owners and admins.

type StateRow = {
  launched_at: Date | null;
  launched_by: string | null;
  launch_team_id: string | null;
  launch_channel_id: string | null;
  dismissed_at: Date | null;
  dismissed_by: string | null;
};
type MarkRow = { step: string; kind: string; marked_by: string | null; marked_at: Date };

/** The workspace's checklist state; a workspace that has done nothing yet has no rows and reads as empty. */
export async function readState(tx: PluginTx): Promise<OnboardingState> {
  const row = (
    await tx.query<StateRow>(
      `SELECT launched_at, launched_by, launch_team_id, launch_channel_id, dismissed_at, dismissed_by FROM app.onboarding_state WHERE workspace_id = $1`,
      [tx.actor.workspaceId],
    )
  ).rows[0];
  const marks = (
    await tx.query<MarkRow>(`SELECT step, kind, marked_by, marked_at FROM app.onboarding_marks WHERE workspace_id = $1 ORDER BY marked_at, step`, [
      tx.actor.workspaceId,
    ])
  ).rows;
  return OnboardingState.parse({
    marks: marks.map((m) => ({ step: m.step, kind: m.kind, markedBy: m.marked_by, markedAt: m.marked_at.toISOString() })),
    launch:
      row?.launched_at && row.launch_team_id && row.launch_channel_id
        ? { at: row.launched_at.toISOString(), by: row.launched_by, teamId: row.launch_team_id, channelId: row.launch_channel_id }
        : null,
    dismissedAt: row?.dismissed_at ? row.dismissed_at.toISOString() : null,
    dismissedBy: row?.dismissed_by ?? null,
  });
}

/** Which kind each markable step takes: password-only is a confirmation of sign-in, the rest can only be set aside. */
const KIND_OF: Record<OnboardingMarkStep, OnboardingMarkKind> = {
  signin: 'acknowledged',
  code: 'skipped',
  infrastructure: 'skipped',
  servers: 'skipped',
};

export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: getOnboardingRoute.method,
    path: getOnboardingRoute.path,
    schema: { response: OnboardingStateResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      return json({ state: await readState(tx) });
    }),
  });

  ctx.http.route({
    method: setOnboardingMarkRoute.method,
    path: setOnboardingMarkRoute.path,
    schema: { body: SetOnboardingMarkRequest, response: OnboardingStateResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { step } = OnboardingStepPathParams.parse(req.params);
      const { kind } = SetOnboardingMarkRequest.parse(req.body);
      if (KIND_OF[step] !== kind) {
        throw conflict(step === 'signin' ? 'Sign-in can only be confirmed as password only.' : 'That step can only be set aside.');
      }
      const written = await tx.query(
        `INSERT INTO app.onboarding_marks (workspace_id, step, kind, marked_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, step) DO NOTHING RETURNING step`,
        [tx.actor.workspaceId, step, kind, tx.actor.id],
      );
      if (written.rows.length > 0) {
        await ctx.audit.emit(tx, {
          type: 'onboarding.step.marked',
          workspaceId: tx.actor.workspaceId,
          step,
          kind,
          markedBy: tx.actor.id,
          at: ctx.runtime.now().toISOString(),
        });
      }
      return json({ state: await readState(tx) });
    }),
  });

  ctx.http.route({
    method: clearOnboardingMarkRoute.method,
    path: clearOnboardingMarkRoute.path,
    schema: { response: OnboardingStateResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { step } = OnboardingStepPathParams.parse(req.params);
      const removed = await tx.query(`DELETE FROM app.onboarding_marks WHERE workspace_id = $1 AND step = $2 RETURNING step`, [
        tx.actor.workspaceId,
        step,
      ]);
      if (removed.rows.length > 0) {
        await ctx.audit.emit(tx, {
          type: 'onboarding.step.marked',
          workspaceId: tx.actor.workspaceId,
          step,
          kind: null,
          markedBy: tx.actor.id,
          at: ctx.runtime.now().toISOString(),
        });
      }
      return json({ state: await readState(tx) });
    }),
  });

  ctx.http.route({
    method: launchOnboardingRoute.method,
    path: launchOnboardingRoute.path,
    schema: { body: LaunchOnboardingRequest, response: OnboardingStateResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const body = LaunchOnboardingRequest.parse(req.body);
      // The first launch counts; a repeat (the person sends a second goal) changes nothing and writes no second event.
      const first = await tx.query(
        `INSERT INTO app.onboarding_state AS s (workspace_id, launched_at, launched_by, launch_team_id, launch_channel_id)
         VALUES ($1, now(), $2, $3, $4)
         ON CONFLICT (workspace_id) DO UPDATE
           SET launched_at = now(), launched_by = EXCLUDED.launched_by, launch_team_id = EXCLUDED.launch_team_id,
               launch_channel_id = EXCLUDED.launch_channel_id, updated_at = now()
           WHERE s.launched_at IS NULL
         RETURNING workspace_id`,
        [tx.actor.workspaceId, tx.actor.id, body.teamId, body.channelId],
      );
      if (first.rows.length > 0) {
        await ctx.audit.emit(tx, {
          type: 'onboarding.goal.launched',
          workspaceId: tx.actor.workspaceId,
          teamId: body.teamId,
          channelId: body.channelId,
          launchedBy: tx.actor.id,
          at: ctx.runtime.now().toISOString(),
        });
      }
      return json({ state: await readState(tx) });
    }),
  });

  ctx.http.route({
    method: dismissOnboardingRoute.method,
    path: dismissOnboardingRoute.path,
    schema: { response: OnboardingStateResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const current = await readState(tx);
      if (current.launch === null) {
        throw conflict('Send your first goal to Brain before putting the checklist away.');
      }
      const dismissed = await tx.query(
        `UPDATE app.onboarding_state SET dismissed_at = now(), dismissed_by = $2, updated_at = now()
          WHERE workspace_id = $1 AND dismissed_at IS NULL AND launched_at IS NOT NULL RETURNING workspace_id`,
        [tx.actor.workspaceId, tx.actor.id],
      );
      if (dismissed.rows.length > 0) {
        await ctx.audit.emit(tx, {
          type: 'onboarding.checklist.dismissed',
          workspaceId: tx.actor.workspaceId,
          dismissedBy: tx.actor.id,
          at: ctx.runtime.now().toISOString(),
        });
      }
      return json({ state: await readState(tx) });
    }),
  });
}
