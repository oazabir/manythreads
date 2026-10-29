import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import type { ApiRoute } from '../client/route.ts';

// Workspace → System health (PLAN P10-10). The same numbers the server's `/metrics` endpoint hands to a monitoring system, shown to workspace
// admins, plus the verdict of each check against its limit. Read-only; the limits are set by the deployment's environment, not here.

const count = z.number().int().nonnegative();
const seconds = z.number().nonnegative();

/** A volume the server can see (the attachment store, the team repositories) and how full it is. */
export const OpsVolume = z.object({
  name: z.string().min(1).max(40),
  totalBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  usedPercent: z.number().min(0).max(100),
});
export type OpsVolume = z.infer<typeof OpsVolume>;

/**
 * Everything measured in one pass. A section is `null` when it could not be read (the table is missing or the query failed); the health
 * watcher then skips the checks that depend on it rather than reporting a guess.
 */
export const OpsHealthSnapshot = z.object({
  takenAt: IsoDateTime,
  /** The outbox: events written with a change and not yet handed to every subscriber. `oldestAgeSeconds` is the outbox lag. */
  outbox: z.object({ backlog: count, retrying: count, oldestAgeSeconds: seconds }).nullable(),
  /** Background jobs waiting for a worker (`ready`, due now), running, and given up on (`dead`). */
  jobs: z
    .object({
      ready: count,
      running: count,
      dead: count,
      oldestReadyAgeSeconds: seconds,
      queues: z.array(z.object({ queue: z.string(), ready: count, oldestAgeSeconds: seconds })),
    })
    .nullable(),
  /** Bot run slots: runs in progress against the limit of runs at once in one server process, and runs waiting for a slot. */
  runs: z.object({ slotsUsed: count, slotsLimit: count, queued: count, oldestQueuedAgeSeconds: seconds }).nullable(),
  approvals: z.object({ pending: count, oldestPendingAgeSeconds: seconds }).nullable(),
  /** Model budgets: how many have a dollar cap, how many are at 80 % or more, how many are used up, and the fullest one. */
  budgets: z.object({ limits: count, nearLimit: count, exhausted: count, maxBurnPercent: z.number().nonnegative() }).nullable(),
  database: z.object({ connectionsUsed: count, connectionsMax: count }).nullable(),
  process: z.object({
    residentBytes: count,
    heapUsedBytes: count,
    eventLoopLagP99Seconds: seconds,
    uptimeSeconds: seconds,
  }),
  volumes: z.array(OpsVolume),
});
export type OpsHealthSnapshot = z.infer<typeof OpsHealthSnapshot>;

/** One check against its limit. `value` is `null` when the section it reads could not be measured. */
export const OpsHealthCheck = z.object({
  name: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  unit: z.enum(['percent', 'seconds']),
  value: z.number().nullable(),
  /** 0 means the check is switched off. */
  threshold: z.number().nonnegative(),
  breached: z.boolean(),
  /** When the current episode began; `null` while the check is fine. */
  since: IsoDateTime.nullable(),
});
export type OpsHealthCheck = z.infer<typeof OpsHealthCheck>;

export const OpsHealthResponse = z.object({
  snapshot: OpsHealthSnapshot,
  checks: z.array(OpsHealthCheck),
});
export type OpsHealthResponse = z.infer<typeof OpsHealthResponse>;

/** Workspace owners and admins only. */
export const getOpsHealthRoute = { method: 'GET', path: '/api/admin/health' } as const satisfies ApiRoute;
