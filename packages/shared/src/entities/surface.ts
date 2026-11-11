import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotId, ChannelId, GoalId, MessageId, RunId, SurfaceEventId, SurfaceId, TeamId, WorkspaceId } from '../ids.ts';

// Surfaces (PLAN P9-01, SPEC §14, plugin `surfaces`): a screen a bot drew in OpenUI Lang, kept as the text it wrote plus a version number, and the history
// of what happened to it. Enums match the SQL CHECKs in plugins/surfaces/migrations exactly (packages/kernel/test/schema-enums.test.ts compares both).

/** A surface's title is one line. */
export const SURFACE_TITLE_MAX = 200;
/** The most OpenUI Lang text one surface holds (characters). The database CHECK says the same number. */
export const SURFACE_SOURCE_MAX = 200_000;
/** The most JSON text one history line carries as its payload (characters); the database CHECK says the same number. */
export const SURFACE_EVENT_PAYLOAD_MAX = 65_536;
/** The longest node name (the name a bot gives a part of its surface, such as `root` or `sales_table`). */
export const SURFACE_NODE_ID_MAX = 64;

/**
 * What a history line records. A bot writes `render` (the first draw), `update` (a patch of some nodes) and `rejected` (the checker refused some nodes);
 * a person writes `event` (a click or a form sent to the bot), `pinned`, `unpinned` and `exported` (saved as a page).
 */
export const SurfaceEventKind = z.enum(['render', 'update', 'event', 'rejected', 'pinned', 'unpinned', 'exported']);
export type SurfaceEventKind = z.infer<typeof SurfaceEventKind>;

/** Why the checker refused one node of a surface. It is the code a person sees as a card in place of the node and the code the bot gets back. */
export const SurfaceRejectionCode = z.enum([
  'syntax',
  'unknown_component',
  'invalid_props',
  'unresolved_ref',
  'cycle',
  'too_deep',
  'too_large',
  'duplicate',
]);
export type SurfaceRejectionCode = z.infer<typeof SurfaceRejectionCode>;

export const SurfaceTitle = z
  .string()
  .trim()
  .min(1, 'Write a title')
  .max(SURFACE_TITLE_MAX, `A title can have at most ${SURFACE_TITLE_MAX} characters`)
  .refine((t) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(t), { message: 'Write the title on one line' });
export type SurfaceTitle = z.infer<typeof SurfaceTitle>;

/**
 * One surface. It belongs to the channel it was drawn in (a bot conversation counts as a channel) and is read by whoever reads that channel.
 * `source` is the OpenUI Lang text; the viewer's checker (packages/shared/src/surfaces) decides, node by node, what may be drawn.
 */
export const Surface = z.object({
  id: SurfaceId,
  workspaceId: WorkspaceId,
  /** The channel's team; null for a surface in a direct message. */
  teamId: TeamId.nullable(),
  channelId: ChannelId,
  botId: BotId,
  /** The run that drew it (the latest run that changed it); null once that run's record is gone. */
  runId: RunId.nullable(),
  /** The root message of the thread it was drawn in; null for a surface drawn in the channel itself. */
  threadRootId: MessageId.nullable(),
  title: z.string().min(1).max(SURFACE_TITLE_MAX),
  source: z.string().max(SURFACE_SOURCE_MAX),
  /** Starts at 1; goes up by one every time the source changes. */
  version: z.number().int().min(1),
  /** The goal this surface is the plan card of (PLAN P22-03, one card per goal); null for an ordinary surface. */
  goalId: GoalId.nullable(),
  /** The channel message that shows it (so its text line can follow the goal); null until posted, and for an ordinary surface. */
  messageId: MessageId.nullable(),
  /** The channel it is pinned to (the channel bar); null when it is not pinned. Today this can only be the surface's own channel. */
  pinnedChannelId: ChannelId.nullable(),
  pinnedBy: ActorId.nullable(),
  pinnedAt: IsoDateTime.nullable(),
  /** The bot's own actor. */
  createdBy: ActorId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Surface = z.infer<typeof Surface>;

/** One line of a surface's history. Written once, never changed. */
export const SurfaceEvent = z.object({
  id: SurfaceEventId,
  surfaceId: SurfaceId,
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  actorId: ActorId,
  kind: SurfaceEventKind,
  /** The surface's version when this happened. */
  version: z.number().int().min(1),
  /** The node it is about (a patch target, the button that was clicked); null when it is about the whole surface. */
  nodeId: z.string().min(1).max(SURFACE_NODE_ID_MAX).nullable(),
  /** What went with it: the patch, the submitted form, the rejection list. A JSON object. */
  payload: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
});
export type SurfaceEvent = z.infer<typeof SurfaceEvent>;
