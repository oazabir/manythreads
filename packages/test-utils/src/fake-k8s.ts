import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A local double of the part of the Kubernetes API that a team pod's Secrets use: get, server-side apply (a PATCH) and delete of one Secret. Used with
// `MANYTHREADS_HERMES_PODS_TEST_K8S_URL` to follow a project's GitHub token into "the Secret" and out of it again, over real HTTP.

export interface FakeK8s {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** The stored Secrets by `<namespace>/<name>`, as last applied (`data` holds base64 values). */
  secrets: Map<string, { metadata: { name: string; namespace: string }; data?: Record<string, string>; [k: string]: unknown }>;
  /** What the list calls of the node picker answer (P19-08): the cluster's nodes, and the pods, Deployments and volume claims of the pods namespace. Tests fill and change them. */
  nodes: Record<string, unknown>[];
  pods: Record<string, unknown>[];
  deployments: Record<string, unknown>[];
  claims: Record<string, unknown>[];
  /** Every request as `METHOD path`, for assertions about what was (not) asked. */
  calls: string[];
  /** Make the next `count` requests answer 500; with `method`, only requests of that method count (and are failed). */
  failNext(count?: number, method?: string): void;
  stop(): Promise<void>;
}

export async function startFakeK8s(): Promise<FakeK8s> {
  const secrets: FakeK8s['secrets'] = new Map();
  const calls: string[] = [];
  const nodes: FakeK8s['nodes'] = [];
  const pods: FakeK8s['pods'] = [];
  const deployments: FakeK8s['deployments'] = [];
  const claims: FakeK8s['claims'] = [];
  let failing = 0;
  let failingMethod: string | null = null;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      calls.push(`${req.method} ${path}`);
      const send = (status: number, doc: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(doc));
      };
      if (failing > 0 && (failingMethod === null || failingMethod === req.method)) {
        failing--;
        return send(500, { kind: 'Status', message: 'forced failure' });
      }
      if (req.method === 'GET') {
        if (path === '/api/v1/nodes') return send(200, { kind: 'NodeList', items: nodes });
        if (/^\/api\/v1\/namespaces\/[^/]+\/pods$/.test(path)) return send(200, { kind: 'PodList', items: pods });
        if (/^\/apis\/apps\/v1\/namespaces\/[^/]+\/deployments$/.test(path)) return send(200, { kind: 'DeploymentList', items: deployments });
        if (/^\/api\/v1\/namespaces\/[^/]+\/persistentvolumeclaims$/.test(path)) return send(200, { kind: 'PersistentVolumeClaimList', items: claims });
      }
      // a merge patch of a volume claim's annotations (the admin's "confirm the move"); a null value removes the annotation
      const claimPath = /^\/api\/v1\/namespaces\/[^/]+\/persistentvolumeclaims\/([^/]+)$/.exec(path);
      if (claimPath && req.method === 'PATCH') {
        const found = claims.find((c) => (c['metadata'] as { name?: string } | undefined)?.name === decodeURIComponent(claimPath[1]!));
        if (!found) return send(404, { kind: 'Status', message: 'not found' });
        const patch = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { metadata?: { annotations?: Record<string, string | null> } };
        const meta = found['metadata'] as { annotations?: Record<string, string> };
        const next = { ...(meta.annotations ?? {}) };
        for (const [k, v] of Object.entries(patch.metadata?.annotations ?? {})) {
          if (v === null) delete next[k];
          else next[k] = v;
        }
        meta.annotations = next;
        return send(200, found);
      }
      const secret = /^\/api\/v1\/namespaces\/([^/]+)\/secrets\/([^/]+)$/.exec(path);
      if (!secret) return send(404, { kind: 'Status', message: 'not found' }); // e.g. the team's Deployment: no other pod owns the name
      const key = `${decodeURIComponent(secret[1]!)}/${decodeURIComponent(secret[2]!)}`;
      if (req.method === 'GET') {
        const s = secrets.get(key);
        return s ? send(200, s) : send(404, { kind: 'Status', message: 'not found' });
      }
      if (req.method === 'PATCH') {
        const doc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { metadata: { name: string; namespace: string }; data?: Record<string, string> };
        secrets.set(key, doc);
        return send(200, doc);
      }
      if (req.method === 'DELETE') {
        return secrets.delete(key) ? send(200, { kind: 'Status', status: 'Success' }) : send(404, { kind: 'Status', message: 'not found' });
      }
      return send(405, { kind: 'Status', message: 'method not allowed' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    secrets,
    nodes,
    pods,
    deployments,
    claims,
    calls,
    failNext: (count = 1, method) => {
      failing = count;
      failingMethod = method ?? null;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
