import type { PluginContext } from '@manythreads/sdk';
import type { OpsHealthSnapshot } from '@manythreads/shared';
import { z } from 'zod';
import { DeadJobCounter, collectDatabaseSections, collectProcess, collectVolumes, startLoopMonitor } from './collect.ts';
import { runSlotsLimitFrom, volumesFrom } from './config.ts';
import type { StateMap } from './evaluate.ts';
import type { SectionStatus } from './prometheus.ts';

/** What one pass measured, and which sections could be read. */
export interface Measured {
  snapshot: OpsHealthSnapshot;
  sections: SectionStatus;
}

/** A snapshot is reused for this long, so a scrape every few seconds and an open panel do not each run the queries. */
const REUSE_MS = 5_000;

export interface Monitor {
  /** The current numbers (reused for a few seconds). */
  measure(): Promise<Measured>;
}

/**
 * The one place the plugin takes its measurements: one system transaction for the database sections, the volumes, and the process. A pass that
 * is already running is shared by whoever asks meanwhile.
 */
export function createMonitor(ctx: PluginContext, env: NodeJS.ProcessEnv): Monitor {
  const loop = startLoopMonitor();
  const dead = new DeadJobCounter(() =>
    ctx.db.system(async (tx) => Number((await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.jobs WHERE state = 'dead'")).rows[0]?.n ?? 0)),
  );
  let last: { at: number; value: Measured } | null = null;
  let inFlight: Promise<Measured> | null = null;

  const run = async (): Promise<Measured> => {
    const now = ctx.runtime.now();
    const sections: Record<string, boolean> = {};
    const failed = (section: string): void => {
      sections[section] = false;
    };
    // Read before the section transaction opens: inside it, the read would need a second connection while this one is held, and a busy
    // pool (the moment these numbers matter most) could then wait on itself.
    const deadJobs = await dead.get();
    const dbPart = await ctx.db.system((tx) =>
      collectDatabaseSections(tx, {
        runSlotsLimit: runSlotsLimitFrom(env),
        deadJobs: async () => deadJobs,
        onSectionError: failed,
      }),
    );
    for (const key of ['outbox', 'jobs', 'runs', 'approvals', 'budgets', 'database']) sections[key] ??= true;
    const volumes = await collectVolumes(volumesFrom(env), (name) => {
      sections[`volume_${name}`] = false;
    });
    const snapshot: OpsHealthSnapshot = { takenAt: now.toISOString(), ...dbPart, process: collectProcess(loop), volumes };
    return { snapshot, sections };
  };

  return {
    async measure() {
      const t = Date.now();
      if (last && t - last.at < REUSE_MS) return last.value;
      inFlight ??= run()
        .then((value) => {
          last = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

/** The health watcher's memory per workspace: what each check was last known to be. Anything unreadable is treated as no memory. */
export const HEALTH_STATE_KEY = 'health-state';

const CheckStateShape = z.object({
  breached: z.boolean(),
  since: z.string().nullable(),
  clearRounds: z.number().int().nonnegative(),
  conditionSince: z.string().nullable(),
});

export function parseState(raw: unknown): StateMap {
  const parsed = z.record(z.string(), CheckStateShape).safeParse(raw);
  return parsed.success ? parsed.data : {};
}
