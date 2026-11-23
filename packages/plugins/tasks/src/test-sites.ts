import type { PluginContext } from '@manythreads/sdk';

/*
 * P35-03 (docs/plans/test-site-per-card.md): the test-site slots a card leases. A team's slots are its deploy targets (the chart's
 * `hermesPods.deployTargets`, the setting MANYTHREADS_HERMES_PODS_DEPLOY_TARGETS that the hermes-pods plugin reads too; plugins do not import each
 * other, so it is read here again). The list is written into `app.test_site_slots` before every lease and by the teardown timer.
 */

export interface SlotSetting {
  team: string;
  namespace: string;
  host: string;
}

const NAMESPACE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The slots of the setting: each target with a plain namespace and its first plain host; anything else is left out. */
export function slotsFromSetting(raw: string | undefined): SlotSetting[] {
  if (!raw || raw.trim() === '') return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const out: SlotSetting[] = [];
    for (const e of list) {
      const o = e as { team?: unknown; namespace?: unknown; hosts?: unknown };
      const host = Array.isArray(o.hosts) && typeof o.hosts[0] === 'string' ? o.hosts[0].toLowerCase() : '';
      if (typeof o.team !== 'string' || o.team === '' || typeof o.namespace !== 'string' || !NAMESPACE.test(o.namespace) || !HOST.test(host)) continue;
      out.push({ team: o.team, namespace: o.namespace, host });
    }
    return out;
  } catch {
    return [];
  }
}

/** Writes the setting's slots into the table (system), so a lease and the teardown see the list the server runs with. */
export async function syncSlots(ctx: PluginContext, raw = process.env['MANYTHREADS_HERMES_PODS_DEPLOY_TARGETS']): Promise<number> {
  const slots = slotsFromSetting(raw);
  return ctx.db.system(async (tx) => (await tx.query<{ n: number }>('SELECT app.tasks_sync_test_site_slots($1::jsonb) AS n', [JSON.stringify(slots)])).rows[0]?.n ?? 0);
}

const LEASE_WORDS: Record<string, string> = {
  no_slots: 'this team has no test-site slots: deploy to its test site as before',
  not_found: 'no such card',
  not_owner: 'only the card’s owner (or a lead) can lease a test site for it',
  already_done: 'the card is finished; it needs no test site',
};

export function registerTestSiteCapabilities(ctx: PluginContext): void {
  // `tasks.test_site_lease`: the slot (namespace and host) the card's test site goes to. The Deployer calls it with `build: true` before it builds.
  ctx.capabilities.register('tasks.test_site_lease', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    if (!UUID.test(taskId)) return { ok: false, code: 'invalid_input', message: 'taskId must be the card id (a uuid)' };
    const build = input['build'] === true;
    await syncSlots(ctx);
    const r = (
      await tx.query<{ o_outcome: string; o_namespace: string | null; o_host: string | null; o_holders: string }>('SELECT * FROM app.tasks_lease_test_site($1::uuid, $2)', [taskId, build])
    ).rows[0];
    if (!r) return { ok: false, code: 'internal', message: 'the lease answered nothing' };
    if (r.o_outcome === 'leased') {
      return { ok: true, taskId, namespace: r.o_namespace, host: r.o_host, url: `https://${r.o_host}`, kubeContext: r.o_namespace, building: build };
    }
    if (r.o_outcome === 'busy') {
      return { ok: false, code: 'busy', message: `every test site is in use (${r.o_holders}): say so in the thread and hand the card back to the engineer; it frees when one of those cards is done` };
    }
    if (r.o_outcome === 'build_busy') {
      return { ok: false, code: 'build_busy', namespace: r.o_namespace, host: r.o_host, message: `another card is building now (${r.o_holders}); only one build runs at a time: try again in a few minutes` };
    }
    return { ok: false, code: r.o_outcome, message: LEASE_WORDS[r.o_outcome] ?? r.o_outcome };
  });
}
