import type { EventMeta, PluginEvent, PluginTx } from '@manythreads/sdk';
import {
  AnswerAnswerPostedEvent,
  ApprovalsApprovalDecidedEvent,
  ApprovalsApprovalRequestedEvent,
  BotsRunClosedEvent,
  IdentityOidcSignedInEvent,
  IdentitySessionSignInFailedEvent,
  IdentitySessionSignedInEvent,
} from '@manythreads/shared';
import { derivedId, type EventRow } from './write.ts';

// The live emitters: events the platform already writes, turned into counted rows. Each reads only ids, outcomes and fixed words from the event. A
// lookup (a run's team, an approval's wait, a person's actor) reads a row by id and takes only an id or a time from it, never text.

/** The events the plugin listens to, with what each becomes. The manifest lists exactly these. */
export const CONSUMED_EVENTS = [
  'bots.run.closed',
  'approvals.approval.requested',
  'approvals.approval.decided',
  'answer.answer.posted',
  'identity.session.signed_in',
  'identity.oidc.signed_in',
  'identity.session.sign_in_failed',
] as const;
export type ConsumedEvent = (typeof CONSUMED_EVENTS)[number];

async function actorOfPerson(tx: PluginTx, workspaceId: string, personId: string): Promise<string | null> {
  const res = await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'person' AND workspace_id = $1 AND ref_id = $2`, [workspaceId, personId]);
  return res.rows[0]?.id ?? null;
}

/** The rows one delivered event becomes (none for an event this plugin does not count, or one it cannot read). */
export async function rowsOfEvent(event: PluginEvent, meta: EventMeta, tx: PluginTx): Promise<EventRow[]> {
  const at = meta.occurredAt;
  const row = (e: { workspaceId: string }, metric: EventRow['metric'], value: number, rest: Partial<EventRow> = {}): EventRow => ({
    id: derivedId(meta.eventId, metric),
    occurredAt: at,
    workspaceId: e.workspaceId,
    teamId: null,
    actorId: null,
    botId: null,
    metric,
    value,
    dims: {},
    ...rest,
  });

  switch (event.type as ConsumedEvent) {
    case 'bots.run.closed': {
      const e = BotsRunClosedEvent.safeParse(event);
      if (!e.success) return [];
      return [row(e.data, 'run.count', 1, { teamId: e.data.teamId, botId: e.data.botId, dims: { status: e.data.status, trigger: e.data.trigger } })];
    }
    case 'approvals.approval.requested': {
      const e = ApprovalsApprovalRequestedEvent.safeParse(event);
      if (!e.success) return [];
      return [row(e.data, 'approval.requested', 1, { teamId: e.data.teamId, botId: e.data.botId, dims: { source: e.data.source, tool: e.data.tool } })];
    }
    case 'approvals.approval.decided': {
      const e = ApprovalsApprovalDecidedEvent.safeParse(event);
      if (!e.success) return [];
      const out = [row(e.data, 'approval.decided', 1, { teamId: e.data.teamId, botId: e.data.botId, dims: { decision: e.data.decision, source: e.data.source, tool: e.data.tool } })];
      // how long it waited: from the approval's own row (two times, no text)
      const waited = await tx.query<{ seconds: string | null }>(
        `SELECT extract(epoch FROM (decided_at - created_at))::text AS seconds FROM app.approvals WHERE id = $1 AND decided_at IS NOT NULL`,
        [e.data.approvalId],
      );
      const seconds = Number(waited.rows[0]?.seconds);
      if (waited.rows[0]?.seconds != null && Number.isFinite(seconds) && seconds >= 0) {
        out.push(row(e.data, 'approval.wait_seconds', seconds, { teamId: e.data.teamId, botId: e.data.botId, dims: { decision: e.data.decision } }));
      }
      return out;
    }
    case 'answer.answer.posted': {
      const e = AnswerAnswerPostedEvent.safeParse(event);
      if (!e.success) return [];
      // the event carries no team (an answer to a private conversation is that person's): the run's own row says which team the bot ran for
      const run = await tx.query<{ team_id: string }>('SELECT team_id FROM app.bot_runs WHERE id = $1', [e.data.runId]);
      const base = { teamId: run.rows[0]?.team_id ?? null, botId: e.data.botId };
      // "scoped": the reply was made for a person who asked and may rest on what only that person can read; "full": nobody asked (a routine, a task)
      const scope = e.data.askerPersonId === null ? 'answer.full' : 'answer.scoped';
      return [
        row(e.data, scope, 1, base),
        row(e.data, 'answer.citations', e.data.citationCount, base),
        row(e.data, 'answer.dropped', e.data.droppedCount, base),
        row(e.data, 'answer.reached', e.data.reachedCount, base),
      ];
    }
    case 'identity.session.signed_in': {
      const e = IdentitySessionSignedInEvent.safeParse(event);
      if (!e.success) return [];
      return [row(e.data, 'signin.ok', 1, { actorId: await actorOfPerson(tx, e.data.workspaceId, e.data.personId), dims: { method: e.data.method } })];
    }
    case 'identity.oidc.signed_in': {
      const e = IdentityOidcSignedInEvent.safeParse(event);
      if (!e.success) return [];
      return [row(e.data, 'signin.ok', 1, { actorId: await actorOfPerson(tx, e.data.workspaceId, e.data.personId), dims: { method: 'oidc', provider: e.data.kind } })];
    }
    case 'identity.session.sign_in_failed': {
      const e = IdentitySessionSignInFailedEvent.safeParse(event);
      if (!e.success) return [];
      return [row(e.data, 'signin.failed', 1, { actorId: await actorOfPerson(tx, e.data.workspaceId, e.data.personId), dims: { method: e.data.method, reason: e.data.reason } })];
    }
    default:
      return [];
  }
}
