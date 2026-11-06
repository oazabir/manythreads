import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { isRepoOriginAllowed, RunnerNodeName } from '@manythreads/shared';

// A deliberately small Kubernetes client shared by the pod controllers (hermes-pods, claude-pods): only what a controller does (server-side apply, get, list) over the in-cluster ServiceAccount.

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
  /** Set (a string) or remove (null) annotations on an existing object with a merge patch; other fields, and the fields this controller applied, are untouched. Optional: a test double may not have it. */
  annotate?(kind: string, namespace: string, name: string, annotations: Record<string, string | null>): Promise<void>;
  /** The cluster's node objects (a cluster-wide read). Optional for the same reason. */
  listNodes?(): Promise<K8sObject[]>;
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

/** The default field manager (the owner of the fields a controller applies). A second controller passes its own in `HttpK8sOptions.fieldManager`. */
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
  /** The server-side-apply field manager; each controller has its own so that two never fight over a field. */
  fieldManager?: string;
}

export class HttpK8s implements K8s {
  constructor(private readonly opts: HttpK8sOptions) {}

  /** In-cluster: the pod's ServiceAccount token and CA, `KUBERNETES_SERVICE_HOST`/`_PORT`. Throws when the pod has none. */
  static inCluster(env: NodeJS.ProcessEnv = process.env, fieldManager?: string): HttpK8s {
    const host = env['KUBERNETES_SERVICE_HOST'];
    const port = env['KUBERNETES_SERVICE_PORT'] ?? '443';
    if (!host) throw new Error('not running in a cluster (KUBERNETES_SERVICE_HOST is unset)');
    const dir = '/var/run/secrets/kubernetes.io/serviceaccount';
    return new HttpK8s({
      baseUrl: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
      token: () => readFileSync(`${dir}/token`, 'utf8').trim(),
      ca: readFileSync(`${dir}/ca.crt`, 'utf8'),
      ...(fieldManager ? { fieldManager } : {}),
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
    const path = `${resourcePath(obj.kind, ns, obj.metadata.name)}?fieldManager=${encodeURIComponent(this.opts.fieldManager ?? FIELD_MANAGER)}&force=true`;
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

  async annotate(kind: string, namespace: string, name: string, annotations: Record<string, string | null>): Promise<void> {
    const res = await this.call('PATCH', resourcePath(kind, namespace, name), JSON.stringify({ metadata: { annotations } }), 'application/merge-patch+json');
    if (res.status < 200 || res.status >= 300) throw new K8sError(res.status, `annotate ${kind}/${name}: ${res.status} ${statusMessage(res.text)}`);
  }

  /**
   * The cluster's nodes (P19-08). The one cluster-wide read this plugin makes: `get` and `list` on `nodes` through a ClusterRole, nothing else outside the pods namespace.
   * Only the fields the node picker shows are read by the caller; an answer is never logged.
   */
  async listNodes(): Promise<K8sObject[]> {
    const res = await this.call('GET', '/api/v1/nodes');
    if (res.status !== 200) throw new K8sError(res.status, `list nodes: ${res.status} ${statusMessage(res.text)}`);
    return (JSON.parse(res.text) as { items?: K8sObject[] }).items ?? [];
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


// ---- machine choice (P19-08): the marks both controllers put on volume claims and Deployments ----

/** The label a node carries with its own name; a pod's `nodeSelector` on it pins the pod to that machine (P19-08). */
export const HOSTNAME_LABEL = 'kubernetes.io/hostname';
/** On a volume claim: the machine this controller asked the volume to live on. Read back to tell a move from a first start. */
export const NODE_ANNOTATION = 'manythreads.io/node';
/** On the Deployment while the controller is recreating the pod's volumes on another machine; its value is the machine moved to. */
export const MOVING_ANNOTATION = 'manythreads.io/moving';
/**
 * On both volume claims of a team, written by the admin's "confirm the move" (bot-runners, through the `runner.nodes` provider): `<machine>@<epoch milliseconds>`. The
 * controller deletes a team's volumes only when this mark names the machine it is moving to and is not older than the confirmation window (src/move.ts).
 */
export const MOVE_CONFIRMED_ANNOTATION = 'manythreads.io/move-confirmed';
/** On the Deployment while the wanted machine differs from the one the volumes are tied to and the move is not confirmed; its value is the machine wanted. Nothing else is changed. */
export const MOVE_HELD_ANNOTATION = 'manythreads.io/move-held';
/** Set by the scheduler on a volume claim bound to a machine (storage classes that wait for the first pod, such as local-path). */
export const SELECTED_NODE_ANNOTATION = 'volume.kubernetes.io/selected-node';

/** A node name that may be a `nodeSelector` value (a Kubernetes label value). Anything else is ignored, never sent. */
export function isNodeLabelValue(node: string | null | undefined): node is string {
  return typeof node === 'string' && RunnerNodeName.safeParse(node).success;
}

// ---- project repositories ----


/** The part of a pod's settings that names repositories: the chart's static list and the allowed address prefixes. */
export interface RepoConfig {
  repos: { name: string; origin?: string; branch?: string }[];
  repoOriginAllow: string[];
}

/** A repository a team's project asks for on its pod: the project's name, its https address and the branch to check out. */
export interface ProjectRepo {
  name: string;
  origin: string;
  branch?: string;
}

/**
 * The chart's static repository list plus the team's projects. A project whose name the static list already holds is left out (the chart wins).
 * A project whose address is not plain or does not start with an allowed prefix (`repoOriginAllow`) is left out too: it is not cloned, and the pod's
 * list does not mention it, so nothing downstream can claim a copy that does not exist.
 */
export function withProjectRepos<C extends RepoConfig>(cfg: C, projects: readonly ProjectRepo[]): C {
  if (projects.length === 0) return cfg;
  const taken = new Set(cfg.repos.map((r) => r.name));
  const extra = projects
    .filter((p) => !taken.has(p.name) && isRepoOriginAllowed(p.origin, cfg.repoOriginAllow))
    .map((p) => (p.branch ? { name: p.name, origin: p.origin, branch: p.branch } : { name: p.name, origin: p.origin }));
  return { ...cfg, repos: [...cfg.repos, ...extra] };
}
