import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import {
  ActorId,
  BotId,
  CapabilityGrantId,
  EntityLinkId,
  EventId,
  JobId,
  OutboxId,
  PersonId,
  TeamId,
  WorkspaceId,
} from '../ids.ts';

// Phase 1 kernel rows (PLAN.md Appendix A.1). Enums match the SQL CHECKs in 0001_kernel.sql exactly.

/** Open jsonb: any JSON value (B.2 rule 6: no bare unknown). */
export const JsonObject = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof JsonObject>;

export const ActorKind = z.enum(['person', 'bot', 'system']);
export type ActorKind = z.infer<typeof ActorKind>;

/** An identity row: a person, a bot, or the system. `refId` is the person or bot id (the workspace id for system). */
export const Actor = z.object({
  id: ActorId,
  kind: ActorKind,
  workspaceId: WorkspaceId,
  refId: z.union([PersonId, BotId, WorkspaceId]),
  createdAt: IsoDateTime,
});
export type Actor = z.infer<typeof Actor>;

/** One row of the append-only event log. `type` is `domain.noun.verb`; `payload` was validated against the registry. */
export const EventRecord = z.object({
  id: EventId,
  occurredAt: IsoDateTime,
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  actorId: ActorId,
  type: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  payload: JsonObject,
});
export type EventRecord = z.infer<typeof EventRecord>;

/** One delivery of an event to one subscriber. */
export const OutboxDelivery = z.object({
  id: OutboxId,
  eventId: EventId,
  subscriber: z.string().min(1),
  availableAt: IsoDateTime,
  attempts: z.number().int().nonnegative(),
  doneAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type OutboxDelivery = z.infer<typeof OutboxDelivery>;

export const JobState = z.enum(['ready', 'running', 'done', 'failed', 'dead']);
export type JobState = z.infer<typeof JobState>;

export const Job = z.object({
  id: JobId,
  queue: z.string().min(1),
  payload: JsonObject,
  runAt: IsoDateTime,
  state: JobState,
  attempts: z.number().int().nonnegative(),
  dedupeKey: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type Job = z.infer<typeof Job>;

/** A broker allowlist entry derived from BOT.md. */
export const CapabilityGrant = z.object({
  id: CapabilityGrantId,
  teamId: TeamId,
  actorId: ActorId,
  capability: z.string().min(1), // `namespace.verb`
  needsApproval: z.boolean(),
  constraints: JsonObject,
  createdAt: IsoDateTime,
});
export type CapabilityGrant = z.infer<typeof CapabilityGrant>;

export const EntityLink = z.object({
  id: EntityLinkId,
  teamId: TeamId,
  srcType: z.string().min(1),
  srcId: z.uuid(),
  dstType: z.string().min(1),
  dstId: z.uuid(),
  kind: z.string().min(1),
  createdAt: IsoDateTime,
});
export type EntityLink = z.infer<typeof EntityLink>;

export const ScopedKvScopeType = z.enum(['workspace', 'team', 'person']);
export type ScopedKvScopeType = z.infer<typeof ScopedKvScopeType>;

/** Plugin scoped storage; the scope id is a workspace, team or person id depending on `scopeType`. */
export const ScopedKvEntry = z.object({
  plugin: z.string().min(1),
  scopeType: ScopedKvScopeType,
  scopeId: z.uuid(),
  key: z.string().min(1),
  value: z.json(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScopedKvEntry = z.infer<typeof ScopedKvEntry>;

/** A loaded plugin version. Global table (no RLS). */
export const PluginRecord = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  enabled: z.boolean(),
  manifest: JsonObject,
  updatedAt: IsoDateTime,
});
export type PluginRecord = z.infer<typeof PluginRecord>;
