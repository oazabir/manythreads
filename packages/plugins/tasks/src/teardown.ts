import { readFileSync } from 'node:fs';
import type { PluginContext } from '@manythreads/sdk';
import { HttpK8s, type K8s } from '@manythreads/sdk/pods';
import { emitUpdated } from './emit.ts';
import { TASK_SELECT, toTask, type TaskRow } from './rows.ts';
import { syncSlots } from './test-sites.ts';

/*
 * P35-03 (docs/plans/test-site-per-card.md): the server removes a card's test site. Every minute it writes the slots from its settings, asks the
 * database which leased slots must go (the card is done, its pull request closed, a day without a deploy, three days held: `tasks_release_test_sites`)
 * and, for each, deletes the site with that slot's OWN deployer login (the Role of the slot's namespace and nothing else: the server's account may only
 * read that login), then frees the slot (`tasks_test_site_freed`: the card's link cleared, a history line). A delete that fails leaves the slot
 * `releasing`, and the next pass tries again. Nothing outside the slot table's namespaces is ever touched.
 */

export const TEARDOWN_QUEUE = 'tasks.test-site-teardown';
const INSTANCE = 'app.kubernetes.io/instance=manythreads';
/** Kept in a slot: its own login, and the secrets the next install of the site reads again (deploy/preview/README.md). */
const KEEP_SECRETS = new Set(['deployer-token', 'manythreads-server-secrets']);

/** Deletes one test site from its slot `ns`; answers how many objects were deleted. Throws on the first refusal (the pass is tried again). */
export async function teardownSite(k8s: K8s, ns: string): Promise<number> {
  let n = 0;
  const del = async (kind: string, name: string): Promise<void> => {
    await k8s.delete(kind, ns, name);
    n++;
  };
  const named = (o: { metadata: { name?: string } }): string => o.metadata.name ?? '';
  // the database first (its operator removes its pods), then the workloads and what routes to them; deletes are Background, so pods go with their owners
  for (const kind of ['Cluster', 'Deployment', 'StatefulSet', 'Ingress', 'Certificate', 'Issuer', 'Service', 'ConfigMap']) {
    for (const o of await k8s.list(kind, ns, INSTANCE)) await del(kind, named(o));
  }
  // every Job of a slot is the card's (its builds and the seed), and so is every volume claim; the patch series of a build is a `patches-<tag>` ConfigMap
  for (const o of await k8s.list('Job', ns, '')) await del('Job', named(o));
  for (const o of await k8s.list('ConfigMap', ns, '')) if (named(o).startsWith('patches-')) await del('ConfigMap', named(o));
  // Helm's record of the release, and the release's own secrets, but never the slot's login or the kept ones
  for (const o of await k8s.list('Secret', ns, 'owner=helm,name=manythreads')) await del('Secret', named(o));
  for (const o of await k8s.list('Secret', ns, INSTANCE)) if (!KEEP_SECRETS.has(named(o))) await del('Secret', named(o));
  for (const o of await k8s.list('PersistentVolumeClaim', ns, '')) await del('PersistentVolumeClaim', named(o));
  return n;
}

const b64 = (v: unknown): string => (typeof v === 'string' ? Buffer.from(v, 'base64').toString('utf8') : '');

/** The cluster as the server's own account (to read a slot's login), and a client logged in as one slot's deployer. */
export interface Cluster {
  server: K8s;
  asSlot(token: string, caPem: string): K8s;
}

export function inCluster(env: NodeJS.ProcessEnv = process.env): Cluster | null {
  // tests: a local double, NODE_ENV=test only
  const testUrl = env['NODE_ENV'] === 'test' ? (env['MANYTHREADS_TASKS_TEST_K8S_URL'] ?? '') : '';
  if (testUrl !== '') return { server: new HttpK8s({ baseUrl: testUrl, token: 'test' }), asSlot: (token) => new HttpK8s({ baseUrl: testUrl, token }) };
  const host = env['KUBERNETES_SERVICE_HOST'];
  if (!host) return null;
  const baseUrl = `https://${host.includes(':') ? `[${host}]` : host}:${env['KUBERNETES_SERVICE_PORT'] ?? '443'}`;
  let ca = '';
  try {
    ca = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'utf8');
  } catch {
    return null;
  }
  return { server: HttpK8s.inCluster(env, 'manythreads-tasks'), asSlot: (token, caPem) => new HttpK8s({ baseUrl, token, ca: caPem || ca, fieldManager: 'manythreads-tasks' }) };
}

/** One pass: the slots to free, each torn down with its own login and then freed. Answers what it did, for the job's log and for tests. */
export async function teardownPass(ctx: PluginContext, cluster: Cluster | null, log: (line: string) => void): Promise<{ freed: string[]; failed: string[] }> {
  await syncSlots(ctx);
  const due = await ctx.db.system(async (tx) => (await tx.query<{ o_namespace: string; o_task_id: string | null; o_reason: string }>('SELECT * FROM app.tasks_release_test_sites($1::interval, $2::interval)', ['1 day', '3 days'])).rows);
  const out = { freed: [] as string[], failed: [] as string[] };
  if (due.length === 0) return out;
  if (!cluster) {
    log('test sites: no cluster to remove sites from; the slots stay releasing');
    return out;
  }
  for (const d of due) {
    try {
      const login = await cluster.server.get('Secret', d.o_namespace, 'deployer-token');
      const data = (login?.data ?? {}) as Record<string, string>;
      const token = b64(data['token']);
      if (token === '') throw new Error('the slot has no ready deployer login');
      const n = await teardownSite(cluster.asSlot(token, b64(data['ca.crt'])), d.o_namespace);
      await ctx.db.system(async (tx) => {
        const before = d.o_task_id ? (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1::uuid`, [d.o_task_id])).rows[0] : undefined;
        await tx.query('SELECT app.tasks_test_site_freed($1)', [d.o_namespace]);
        const after = d.o_task_id ? (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1::uuid`, [d.o_task_id])).rows[0] : undefined;
        if (before && after) await emitUpdated(ctx, tx, toTask(before), toTask(after));
      });
      log(`test sites: removed the site in ${d.o_namespace} (${d.o_reason}; ${n} objects)`);
      out.freed.push(d.o_namespace);
    } catch (err) {
      // the error's words only: a Kubernetes status message, never a token
      log(`test sites: could not remove the site in ${d.o_namespace}: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}; tried again next minute`);
      out.failed.push(d.o_namespace);
    }
  }
  return out;
}

export function registerTestSiteTeardown(ctx: PluginContext, clusterOf: () => Cluster | null = () => inCluster()): void {
  let cluster: Cluster | null | undefined;
  ctx.jobs.register(
    TEARDOWN_QUEUE,
    async (_payload, _tx, job) => {
      cluster ??= clusterOf();
      await teardownPass(ctx, cluster, (line) => job.log.info(line));
    },
    // detached: the pass waits on the cluster, so it must not hold a transaction while it does
    { cron: '* * * * *', detached: true },
  );
}
