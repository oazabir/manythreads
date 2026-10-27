import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A local double of the part of the Kubernetes API that a team pod's Secrets use: get, server-side apply (a PATCH) and delete of one Secret. Used with
// `MANYTHREADS_HERMES_PODS_TEST_K8S_URL` to follow a project's GitHub token into "the Secret" and out of it again, over real HTTP.

export interface FakeK8s {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** The stored Secrets by `<namespace>/<name>`, as last applied (`data` holds base64 values). */
  secrets: Map<string, { metadata: { name: string; namespace: string }; data?: Record<string, string>; [k: string]: unknown }>;
  /** Every request as `METHOD path`, for assertions about what was (not) asked. */
  calls: string[];
  /** Make the next `count` requests answer 500. */
  failNext(count?: number): void;
  stop(): Promise<void>;
}

export async function startFakeK8s(): Promise<FakeK8s> {
  const secrets: FakeK8s['secrets'] = new Map();
  const calls: string[] = [];
  let failing = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      calls.push(`${req.method} ${path}`);
      const send = (status: number, doc: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(doc));
      };
      if (failing > 0) {
        failing--;
        return send(500, { kind: 'Status', message: 'forced failure' });
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
    calls,
    failNext: (count = 1) => {
      failing = count;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
