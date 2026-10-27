import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';

// A deliberately small Kubernetes client: only what the controller does (server-side apply, get, list) over the in-cluster ServiceAccount.

export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; [k: string]: unknown };
  [k: string]: unknown;
}

export interface K8s {
  /** Create or update `obj` (server-side apply; this controller owns the fields it sends). */
  apply(obj: K8sObject): Promise<void>;
  /** The object, or null when it does not exist. */
  get(kind: string, namespace: string, name: string): Promise<K8sObject | null>;
  list(kind: string, namespace: string, labelSelector: string): Promise<K8sObject[]>;
  /** Delete the object; one that does not exist is not an error. */
  delete(kind: string, namespace: string, name: string): Promise<void>;
}

const PATHS: Record<string, { prefix: string; plural: string }> = {
  Deployment: { prefix: '/apis/apps/v1', plural: 'deployments' },
  Service: { prefix: '/api/v1', plural: 'services' },
  Secret: { prefix: '/api/v1', plural: 'secrets' },
  ConfigMap: { prefix: '/api/v1', plural: 'configmaps' },
  PersistentVolumeClaim: { prefix: '/api/v1', plural: 'persistentvolumeclaims' },
  Pod: { prefix: '/api/v1', plural: 'pods' },
};

export function resourcePath(kind: string, namespace: string, name?: string): string {
  const p = PATHS[kind];
  if (!p) throw new Error(`unsupported kind ${kind}`);
  return `${p.prefix}/namespaces/${encodeURIComponent(namespace)}/${p.plural}${name ? `/${encodeURIComponent(name)}` : ''}`;
}

export const FIELD_MANAGER = 'manythreads-hermes-pods';

export class K8sError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'K8sError';
  }
}

export interface HttpK8sOptions {
  baseUrl: string;
  /** A token, or a function returning the current one (the projected ServiceAccount token is rotated by the kubelet: read it per request). */
  token: string | (() => string);
  /** PEM of the cluster CA (https only). */
  ca?: string;
}

export class HttpK8s implements K8s {
  constructor(private readonly opts: HttpK8sOptions) {}

  /** In-cluster: the pod's ServiceAccount token and CA, `KUBERNETES_SERVICE_HOST`/`_PORT`. Throws when the pod has none. */
  static inCluster(env: NodeJS.ProcessEnv = process.env): HttpK8s {
    const host = env['KUBERNETES_SERVICE_HOST'];
    const port = env['KUBERNETES_SERVICE_PORT'] ?? '443';
    if (!host) throw new Error('not running in a cluster (KUBERNETES_SERVICE_HOST is unset)');
    const dir = '/var/run/secrets/kubernetes.io/serviceaccount';
    return new HttpK8s({
      baseUrl: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
      token: () => readFileSync(`${dir}/token`, 'utf8').trim(),
      ca: readFileSync(`${dir}/ca.crt`, 'utf8'),
    });
  }

  private call(method: string, path: string, body?: string, contentType?: string): Promise<{ status: number; text: string }> {
    const url = new URL(path, this.opts.baseUrl);
    const secure = url.protocol === 'https:';
    return new Promise((resolve, reject) => {
      const req = (secure ? httpsRequest : httpRequest)(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': contentType ?? 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
          },
          ...(secure && this.opts.ca ? { ca: this.opts.ca } : {}),
          timeout: 20_000,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('kubernetes api timeout')));
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  async apply(obj: K8sObject): Promise<void> {
    const ns = obj.metadata.namespace;
    if (!ns) throw new Error('apply needs a namespaced object');
    const path = `${resourcePath(obj.kind, ns, obj.metadata.name)}?fieldManager=${FIELD_MANAGER}&force=true`;
    const res = await this.call('PATCH', path, JSON.stringify(obj), 'application/apply-patch+yaml');
    if (res.status < 200 || res.status >= 300) throw new K8sError(res.status, `apply ${obj.kind}/${obj.metadata.name}: ${res.status} ${statusMessage(res.text)}`);
  }

  async get(kind: string, namespace: string, name: string): Promise<K8sObject | null> {
    const res = await this.call('GET', resourcePath(kind, namespace, name));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new K8sError(res.status, `get ${kind}/${name}: ${res.status} ${statusMessage(res.text)}`);
    return JSON.parse(res.text) as K8sObject;
  }

  async delete(kind: string, namespace: string, name: string): Promise<void> {
    const res = await this.call('DELETE', resourcePath(kind, namespace, name));
    if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw new K8sError(res.status, `delete ${kind}/${name}: ${res.status} ${statusMessage(res.text)}`);
  }

  async list(kind: string, namespace: string, labelSelector: string): Promise<K8sObject[]> {
    const res = await this.call('GET', `${resourcePath(kind, namespace)}?labelSelector=${encodeURIComponent(labelSelector)}`);
    if (res.status !== 200) throw new K8sError(res.status, `list ${kind}: ${res.status} ${statusMessage(res.text)}`);
    return (JSON.parse(res.text) as { items?: K8sObject[] }).items ?? [];
  }
}

/** The `message` of a Kubernetes Status body, never the whole body (it can echo what was sent). */
function statusMessage(text: string): string {
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message;
    return typeof m === 'string' ? m.slice(0, 300) : '';
  } catch {
    return '';
  }
}
