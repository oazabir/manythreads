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
  launch_message_id: string | null;
  dismissed_at: Date | null;
  dismissed_by: string | null;
};
type MarkRow = { step: string; kind: string; marked_by: string | null; marked_at: Date; ref_id: string | null };

/** The workspace's checklist state; a workspace that has done nothing yet has no rows and reads as empty. */
export async function readState(tx: PluginTx): Promise<OnboardingState> {
  const row = (
    await tx.query<StateRow>(
      `SELECT launched_at, launched_by, launch_team_id, launch_channel_id, launch_message_id, dismissed_at, dismissed_by FROM app.onboarding_state WHERE workspace_id = $1`,
      [tx.actor.workspaceId],
    )
  ).rows[0];
  const marks = (
    await tx.query<MarkRow>(`SELECT step, kind, marked_by, marked_at, ref_id FROM app.onboarding_marks WHERE workspace_id = $1 ORDER BY marked_at, step`, [
      tx.actor.workspaceId,
    ])
  ).rows;
  return OnboardingState.parse({
    marks: marks.map((m) => ({ step: m.step, kind: m.kind, markedBy: m.marked_by, markedAt: m.marked_at.toISOString(), refId: m.ref_id })),
    launch:
      row?.launched_at && row.launch_team_id && row.launch_channel_id
        ? { at: row.launched_at.toISOString(), by: row.launched_by, teamId: row.launch_team_id, channelId: row.launch_channel_id, messageId: row.launch_message_id }
        : null,
    dismissedAt: row?.dismissed_at ? row.dismissed_at.toISOString() : null,
    dismissedBy: row?.dismissed_by ?? null,
  });
}

/** Which kinds each markable step takes: a confirmation (sign-in, theme), a set-aside (the optional steps), a proof (runners) or a start (delivery). */
const KINDS_OF: Record<OnboardingMarkStep, readonly OnboardingMarkKind[]> = {
  signin: ['acknowledged'],
  theme: ['acknowledged'],
  code: ['skipped'],
  infrastructure: ['skipped'],
  servers: ['skipped'],
  runners: ['checked'],
  delivery: ['skipped', 'started'],
};
/** A proof or a start points at what it is about; a decision does not. */
const needsRef = (kind: OnboardingMarkKind): boolean => kind === 'checked' || kind === 'started';

const wrongKind = (step: OnboardingMarkStep): string =>
  step === 'signin'
    ? 'Sign-in can only be confirmed as password only.'
    : step === 'theme'
      ? 'The theme can only be kept as it is.'
      : step === 'runners'
        ? 'A runner step is only recorded as a runner that answered a test.'
        : step === 'delivery'
          ? 'The first delivery can only be started or set aside.'
          : 'That step can only be set aside.';

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
      const { kind, refId } = SetOnboardingMarkRequest.parse(req.body);
      if (!KINDS_OF[step].includes(kind)) throw conflict(wrongKind(step));
      if (needsRef(kind) !== (refId !== undefined)) throw conflict(needsRef(kind) ? 'Say what was checked or started.' : 'A decision points at nothing.');
      // A decision keeps its first record. A proof or a start is the latest one: a second delivery, or a second runner that answered, replaces the first.
      const written = await tx.query(
        `INSERT INTO app.onboarding_marks AS m (workspace_id, step, kind, marked_by, ref_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, step) DO UPDATE SET kind = EXCLUDED.kind, marked_by = EXCLUDED.marked_by, ref_id = EXCLUDED.ref_id, marked_at = now()
           WHERE EXCLUDED.ref_id IS NOT NULL AND m.ref_id IS DISTINCT FROM EXCLUDED.ref_id
         RETURNING step`,
        [tx.actor.workspaceId, step, kind, tx.actor.id, refId ?? null],
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
        `INSERT INTO app.onboarding_state AS s (workspace_id, launched_at, launched_by, launch_team_id, launch_channel_id, launch_message_id)
         VALUES ($1, now(), $2, $3, $4, $5)
         ON CONFLICT (workspace_id) DO UPDATE
           SET launched_at = now(), launched_by = EXCLUDED.launched_by, launch_team_id = EXCLUDED.launch_team_id,
               launch_channel_id = EXCLUDED.launch_channel_id, launch_message_id = EXCLUDED.launch_message_id, updated_at = now()
           WHERE s.launched_at IS NULL
         RETURNING workspace_id`,
        [tx.actor.workspaceId, tx.actor.id, body.teamId, body.channelId, body.messageId ?? null],
      );
      if (first.rows.length === 0 && body.messageId !== undefined) {
        // A second question (the first got no answer) moves the thread the wizard watches; it is not a second launch, so no event and no new time.
        await tx.query(
          `UPDATE app.onboarding_state SET launch_message_id = $2, updated_at = now()
           WHERE workspace_id = $1 AND launched_at IS NOT NULL AND dismissed_at IS NULL AND launch_message_id IS DISTINCT FROM $2`,
          [tx.actor.workspaceId, body.messageId],
        );
      }
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
