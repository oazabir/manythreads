import type { PluginTx } from '@manythreads/sdk';
import { AUDIT_ACTIONS, type AuditActorKind, type AuditOutcome, type KnownAuditAction } from '@manythreads/shared';
import { MAPPERS, clip, memoryReason, memoryTarget, type Mapped, type Who } from './spec.ts';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** One thing that happened, ready to be written: the source row's own columns plus what the mapping made of it. */
export interface Draft {
  /** The id of the event (or memory log line); becomes the audit row's id. */
  id: string;
  workspaceId: string;
  occurredAt: Date;
  /** The `actor_id` of the event row (an actor id), used when the mapping names nobody else. */
  actorId: string | null;
  teamId: string | null;
  mapped: Mapped;
  source: 'event' | 'memory_retain_log';
}

/** Builds the draft of an event, or null when the event type is not audited or the mapping says it is not worth a row. */
export function draftOfEvent(
  event: { type: string; workspaceId?: unknown; [field: string]: unknown },
  meta: { eventId: string; occurredAt: Date; actorId: string; teamId: string | null },
  workspaceId: string,
): Draft | null {
  const mapper = MAPPERS[event.type];
  if (!mapper) return null;
  const mapped = mapper(event);
  if (!mapped) return null;
  return { id: meta.eventId, workspaceId, occurredAt: meta.occurredAt, actorId: meta.actorId, teamId: meta.teamId, mapped, source: 'event' };
}

/** A line of the memory retain log that says something was held back. Only ids, a source kind and a fixed reason code are read. */
export type MemoryLogLine = {
  id: string;
  workspace_id: string;
  team_id: string | null;
  source_kind: string;
  source_id: string;
  reason: string;
  actor_id: string | null;
  created_at: Date;
};

export function draftOfMemoryLine(line: MemoryLogLine): Draft {
  return {
    id: line.id,
    workspaceId: line.workspace_id,
    occurredAt: line.created_at,
    actorId: line.actor_id,
    teamId: line.team_id,
    source: 'memory_retain_log',
    mapped: { action: 'memory.withheld', who: line.actor_id ? undefined : 'system', target: memoryTarget(line.source_kind, line.source_id), outcome: 'withheld', reason: memoryReason(line.reason) },
  };
}

interface Resolved {
  actors: Map<string, { kind: string; refId: string }>;
  people: Map<string, string>;
  bots: Map<string, string>;
  teams: Map<string, string>;
  channels: Map<string, string>;
}

/** The actor pointer of a draft: the mapping's, else the event row's actor. */
function whoOf(d: Draft): Who {
  if (d.mapped.who) return d.mapped.who;
  return d.actorId && d.actorId !== NIL_UUID ? { actor: d.actorId } : 'system';
}

async function resolve(tx: PluginTx, drafts: readonly Draft[]): Promise<Resolved> {
  const actorIds = new Set<string>();
  const personIds = new Set<string>();
  const botIds = new Set<string>();
  const teamIds = new Set<string>();
  const channelIds = new Set<string>();
  for (const d of drafts) {
    const who = whoOf(d);
    if (typeof who === 'object') {
      if ('actor' in who) actorIds.add(who.actor);
      else if ('person' in who) personIds.add(who.person);
      else botIds.add(who.bot);
    }
    const t = d.mapped.target;
    if (t?.named && t.id) (t.named === 'person' ? personIds : t.named === 'bot' ? botIds : t.named === 'team' ? teamIds : channelIds).add(t.id);
    const team = d.mapped.teamId !== undefined ? d.mapped.teamId : d.teamId;
    if (team) teamIds.add(team);
  }
  const actors = new Map<string, { kind: string; refId: string }>();
  if (actorIds.size > 0) {
    const rows = (await tx.query<{ id: string; kind: string; ref_id: string }>('SELECT id, kind, ref_id FROM app.actors WHERE id = ANY($1::uuid[])', [[...actorIds]])).rows;
    for (const r of rows) {
      actors.set(r.id, { kind: r.kind, refId: r.ref_id });
      if (r.kind === 'person') personIds.add(r.ref_id);
      else if (r.kind === 'bot') botIds.add(r.ref_id);
    }
  }
  const named = async (sql: string, ids: Set<string>): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    if (ids.size === 0) return out;
    for (const r of (await tx.query<{ id: string; name: string }>(sql, [[...ids]])).rows) out.set(r.id, r.name);
    return out;
  };
  // one after the other: a transaction runs one statement at a time
  const people = await named('SELECT id, display_name AS name FROM app.people WHERE id = ANY($1::uuid[])', personIds);
  const bots = await named("SELECT id, COALESCE(NULLIF(name, ''), slug) AS name FROM app.bots WHERE id = ANY($1::uuid[])", botIds);
  const teams = await named('SELECT id, name FROM app.teams WHERE id = ANY($1::uuid[])', teamIds);
  const channels = await named('SELECT id, name FROM app.channels WHERE id = ANY($1::uuid[])', channelIds);
  return { actors, people, bots, teams, channels };
}

type Row = {
  id: string;
  workspace_id: string;
  occurred_at: string;
  team_id: string | null;
  team_name: string | null;
  actor_id: string | null;
  actor_kind: AuditActorKind;
  actor_name: string;
  category: string;
  action: KnownAuditAction;
  target_kind: string | null;
  target_id: string | null;
  target_label: string | null;
  outcome: AuditOutcome;
  reason: string | null;
  source: string;
};

/** Turns drafts into rows: looks up the names (as they are now) and fills every column. Pure apart from the lookups. */
export async function rowsOf(tx: PluginTx, drafts: readonly Draft[]): Promise<Row[]> {
  const r = await resolve(tx, drafts);
  return drafts.map((d): Row => {
    const who = whoOf(d);
    let actorId: string | null = null;
    let kind: AuditActorKind = 'system';
    let name = 'System';
    if (typeof who === 'object') {
      let personId: string | null = null;
      let botId: string | null = null;
      if ('actor' in who) {
        const a = r.actors.get(who.actor);
        if (a?.kind === 'person') personId = a.refId;
        else if (a?.kind === 'bot') botId = a.refId;
        else name = 'Unknown';
      } else if ('person' in who) personId = who.person;
      else botId = who.bot;
      if (personId) {
        actorId = personId;
        kind = 'person';
        name = r.people.get(personId) ?? 'Unknown person';
      } else if (botId) {
        actorId = botId;
        kind = 'bot';
        name = r.bots.get(botId) ?? 'Unknown bot';
      }
    }
    const t = d.mapped.target;
    const teamId = d.mapped.teamId !== undefined ? d.mapped.teamId : d.teamId;
    let label = t?.label ?? null;
    if (t && label === null && t.named && t.id) {
      const looked = (t.named === 'person' ? r.people : t.named === 'bot' ? r.bots : t.named === 'team' ? r.teams : r.channels).get(t.id);
      label = looked && looked.length > 0 ? looked : null;
    }
    return {
      id: d.id,
      workspace_id: d.workspaceId,
      occurred_at: d.occurredAt.toISOString(),
      team_id: teamId ?? null,
      team_name: teamId ? (clip(r.teams.get(teamId) ?? '') || null) : null,
      actor_id: actorId,
      actor_kind: kind,
      actor_name: clip(name),
      category: AUDIT_ACTIONS[d.mapped.action].category,
      action: d.mapped.action,
      target_kind: t?.kind ?? null,
      target_id: t?.id ?? null,
      target_label: label === null ? null : clip(label),
      outcome: d.mapped.outcome ?? 'ok',
      reason: d.mapped.reason ? clip(d.mapped.reason) : null,
      source: d.source,
    };
  });
}

/** Writes the drafts (once each: a source already written is skipped) and returns how many rows were new. */
export async function writeDrafts(tx: PluginTx, drafts: readonly Draft[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const rows = await rowsOf(tx, drafts);
  const res = await tx.query(
    `INSERT INTO app.audit_events (id, workspace_id, occurred_at, team_id, team_name, actor_id, actor_kind, actor_name, category, action,
                                   target_kind, target_id, target_label, outcome, reason, source)
     SELECT x.id, x.workspace_id, x.occurred_at, x.team_id, x.team_name, x.actor_id, x.actor_kind, x.actor_name, x.category, x.action,
            x.target_kind, x.target_id, x.target_label, x.outcome, x.reason, x.source
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, workspace_id uuid, occurred_at timestamptz, team_id uuid, team_name text, actor_id uuid,
            actor_kind text, actor_name text, category text, action text, target_kind text, target_id text, target_label text, outcome text,
            reason text, source text)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [JSON.stringify(rows)],
  );
  return res.rows.length;
}
