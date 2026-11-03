import { Surface, SurfaceEvent } from '@manythreads/shared';

// One mapper per table (conventions D1): a row of `surfaces` or `surface_events` becomes the shared type, and nothing else is done here. Always read through the
// caller's own transaction, so row-level security decides who sees what.

export const SURFACE_COLUMNS = `s.id, s.workspace_id, s.team_id, s.channel_id, s.bot_id, s.run_id, s.thread_root_id, s.title, s.source, s.version,
  s.pinned_channel_id, s.pinned_by, s.pinned_at, s.created_by, s.created_at, s.updated_at`;

export type SurfaceRow = {
  id: string;
  workspace_id: string;
  team_id: string | null;
  channel_id: string;
  bot_id: string;
  run_id: string | null;
  thread_root_id: string | null;
  title: string;
  source: string;
  version: number;
  pinned_channel_id: string | null;
  pinned_by: string | null;
  pinned_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export function toSurface(r: SurfaceRow): Surface {
  return Surface.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    channelId: r.channel_id,
    botId: r.bot_id,
    runId: r.run_id,
    threadRootId: r.thread_root_id,
    title: r.title,
    source: r.source,
    version: r.version,
    pinnedChannelId: r.pinned_channel_id,
    pinnedBy: r.pinned_by,
    pinnedAt: r.pinned_at ? r.pinned_at.toISOString() : null,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });
}

export const SURFACE_EVENT_COLUMNS = 'e.id, e.surface_id, e.workspace_id, e.channel_id, e.actor_id, e.kind, e.version, e.node_id, e.payload, e.created_at';

export type SurfaceEventRow = {
  id: string;
  surface_id: string;
  workspace_id: string;
  channel_id: string;
  actor_id: string;
  kind: string;
  version: number;
  node_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

export function toSurfaceEvent(r: SurfaceEventRow): SurfaceEvent {
  return SurfaceEvent.parse({
    id: r.id,
    surfaceId: r.surface_id,
    workspaceId: r.workspace_id,
    channelId: r.channel_id,
    actorId: r.actor_id,
    kind: r.kind,
    version: r.version,
    nodeId: r.node_id,
    payload: r.payload,
    createdAt: r.created_at.toISOString(),
  });
}
