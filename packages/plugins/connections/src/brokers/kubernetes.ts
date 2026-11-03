import { BrokerError, parseServiceUrl, send } from './http.ts';
import { clampLifetime, MAX_CREDENTIAL_SECONDS } from './limits.ts';

// The Kubernetes broker (SPEC §11, PLAN P8-04). A connection holds ONE long-lived credential (the bootstrap token) that may do exactly one thing: ask the
// cluster for a short-lived token of a named service account (the `TokenRequest` API). The bot never sees the bootstrap token and never keeps what it is
// given: every task asks for a fresh token that dies within the hour, uses it for its reads, and drops it. What the token may then do is the service account's
// own role in the cluster, which is where an administrator limits it; this file adds the second fence (a short list of read-only resources and of namespaces).

export interface KubernetesTarget {
  /** `https://host:6443`, no path, no credentials. */
  apiUrl: string;
  /** The long-lived credential that may create tokens for `serviceAccount`; it is never returned and never sent anywhere but `apiUrl`. */
  bootstrapToken: string;
  /** PEM of the cluster's own certificate authority, when it has one. */
  ca?: string;
  /** The namespace of the service account the tokens are for. */
  namespace: string;
  serviceAccount: string;
}

export interface IssuedToken {
  /** The short-lived token. Hand it to nothing but the request it was made for. */
  token: string;
  expiresAt: Date;
}

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** What the cluster may answer for the expiry is only believed up to one hour (plus a minute of clock difference). */
const CLOCK_SKEW_MS = 60_000;

/**
 * Asks the cluster for a token of the connection's service account that lives `ttlSeconds` (held between ten minutes and one hour). A cluster that answers with
 * a token that lives longer than an hour (some clusters stretch token life) is refused: the token is dropped and the task fails, so nothing long-lived is ever
 * handed to a task.
 */
export async function issueKubernetesToken(target: KubernetesTarget, opts: { ttlSeconds?: number; now?: () => Date; audiences?: string[] } = {}): Promise<IssuedToken> {
  if (!NAME.test(target.namespace) || !NAME.test(target.serviceAccount)) throw new BrokerError('The namespace or the service account of this connection is not a valid name.', 'bad_config');
  const base = parseServiceUrl(target.apiUrl, 'cluster');
  const now = opts.now ?? (() => new Date());
  const asked = clampLifetime(opts.ttlSeconds);
  const res = await send({
    url: `${base.origin}/api/v1/namespaces/${encodeURIComponent(target.namespace)}/serviceaccounts/${encodeURIComponent(target.serviceAccount)}/token`,
    method: 'POST',
    headers: { authorization: `Bearer ${target.bootstrapToken}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { expirationSeconds: asked, ...(opts.audiences?.length ? { audiences: opts.audiences } : {}) } }),
    ...(target.ca !== undefined ? { ca: target.ca } : {}),
  });
  if (res.status === 401 || res.status === 403) throw new BrokerError('The cluster refused to give out a token for this connection’s service account.', 'refused');
  if (res.status !== 200 && res.status !== 201) throw new BrokerError('The cluster could not give out a token.', 'unreachable');
  let parsed: { status?: { token?: unknown; expirationTimestamp?: unknown } };
  try {
    parsed = JSON.parse(res.body) as typeof parsed;
  } catch {
    throw new BrokerError('The cluster’s answer to the token request was not understood.', 'bad_answer');
  }
  const token = parsed.status?.token;
  const expiry = typeof parsed.status?.expirationTimestamp === 'string' ? new Date(parsed.status.expirationTimestamp) : null;
  if (typeof token !== 'string' || token === '' || expiry === null || Number.isNaN(expiry.getTime())) {
    throw new BrokerError('The cluster’s answer to the token request was not understood.', 'bad_answer');
  }
  if (expiry.getTime() > now().getTime() + MAX_CREDENTIAL_SECONDS * 1000 + CLOCK_SKEW_MS) {
    throw new BrokerError('The cluster gave out a token that lives longer than one hour, so it was thrown away.', 'too_long_lived');
  }
  return { token, expiresAt: expiry };
}

// --- the read ----------------------------------------------------------------------------------------------------------------------------------------

/** What `kubernetes.get` may read: the names a model uses and the API path of each. Secrets are not here, and nothing here writes. */
const RESOURCES = {
  pods: { path: (ns: string) => `/api/v1/namespaces/${ns}/pods`, namespaced: true },
  services: { path: (ns: string) => `/api/v1/namespaces/${ns}/services`, namespaced: true },
  events: { path: (ns: string) => `/api/v1/namespaces/${ns}/events`, namespaced: true },
  deployments: { path: (ns: string) => `/apis/apps/v1/namespaces/${ns}/deployments`, namespaced: true },
  replicasets: { path: (ns: string) => `/apis/apps/v1/namespaces/${ns}/replicasets`, namespaced: true },
  statefulsets: { path: (ns: string) => `/apis/apps/v1/namespaces/${ns}/statefulsets`, namespaced: true },
  jobs: { path: (ns: string) => `/apis/batch/v1/namespaces/${ns}/jobs`, namespaced: true },
  ingresses: { path: (ns: string) => `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`, namespaced: true },
  namespaces: { path: () => '/api/v1/namespaces', namespaced: false },
  nodes: { path: () => '/api/v1/nodes', namespaced: false },
} as const;

export const KUBERNETES_RESOURCES = Object.keys(RESOURCES) as [keyof typeof RESOURCES, ...Array<keyof typeof RESOURCES>];
export type KubernetesResource = keyof typeof RESOURCES;

/** The most characters of an answer a model is given. */
export const MAX_ANSWER_CHARS = 30_000;

export interface KubernetesRead {
  resource: KubernetesResource;
  namespace?: string;
  /** One object by name; leave out for a list. */
  name?: string;
  /** For `pods` with a name: answer the container log instead (the last `tailLines` lines). */
  log?: boolean;
  tailLines?: number;
  limit?: number;
  container?: string;
}

export type KubernetesAnswer = { ok: true; data: unknown; truncated: boolean } | { ok: false; code: 'not_found' | 'refused' | 'unreachable'; message: string };

const drop = (value: unknown): unknown => {
  // managedFields is bookkeeping that doubles the size of every object and helps nobody
  if (Array.isArray(value)) return value.map(drop);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (k !== 'managedFields') out[k] = drop(v);
    return out;
  }
  return value;
};

/**
 * One read with a token this task just got. `allowedNamespaces` is the connection's own short list: a namespace outside it is refused here, whatever the
 * service account could do. Cluster-wide resources (nodes, namespaces) are read as listed. The answer is cut at {@link MAX_ANSWER_CHARS}.
 */
export async function readKubernetes(target: Pick<KubernetesTarget, 'apiUrl' | 'ca'>, token: string, allowedNamespaces: readonly string[], read: KubernetesRead): Promise<KubernetesAnswer> {
  const spec = RESOURCES[read.resource];
  const pathOf: (ns: string) => string = spec.path;
  const base = parseServiceUrl(target.apiUrl, 'cluster');
  const query = new URLSearchParams();
  let path: string;
  if (spec.namespaced) {
    const ns = read.namespace ?? allowedNamespaces[0];
    if (ns === undefined || !NAME.test(ns) || !allowedNamespaces.includes(ns)) {
      return { ok: false, code: 'refused', message: `This connection may read only the namespaces ${allowedNamespaces.map((n) => `“${n}”`).join(', ')}.` };
    }
    path = pathOf(encodeURIComponent(ns));
  } else {
    path = pathOf('');
  }
  if (read.name !== undefined) {
    if (!NAME.test(read.name)) return { ok: false, code: 'refused', message: 'That is not a valid object name.' };
    path += `/${encodeURIComponent(read.name)}`;
    if (read.log === true) {
      if (read.resource !== 'pods') return { ok: false, code: 'refused', message: 'Only a pod has a log.' };
      path += '/log';
      query.set('tailLines', String(Math.min(500, Math.max(1, Math.floor(read.tailLines ?? 100)))));
      if (read.container !== undefined) {
        if (!NAME.test(read.container)) return { ok: false, code: 'refused', message: 'That is not a valid container name.' };
        query.set('container', read.container);
      }
    }
  } else {
    query.set('limit', String(Math.min(100, Math.max(1, Math.floor(read.limit ?? 50)))));
  }
  const qs = query.toString();
  let res;
  try {
    res = await send({
      url: `${base.origin}${path}${qs === '' ? '' : `?${qs}`}`,
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: read.log === true ? 'text/plain' : 'application/json' },
      ...(target.ca !== undefined ? { ca: target.ca } : {}),
      maxBytes: 5_000_000,
    });
  } catch (error) {
    return { ok: false, code: 'unreachable', message: error instanceof BrokerError ? error.message : 'The cluster could not be reached.' };
  }
  if (res.status === 404) return { ok: false, code: 'not_found', message: 'The cluster has no such object.' };
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'refused', message: 'The cluster says this connection’s service account may not read that.' };
  if (res.status !== 200) return { ok: false, code: 'unreachable', message: 'The cluster could not answer that.' };
  let data: unknown = res.body;
  if (read.log !== true) {
    try {
      data = drop(JSON.parse(res.body));
    } catch {
      return { ok: false, code: 'unreachable', message: 'The cluster’s answer was not understood.' };
    }
  }
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  if (text.length <= MAX_ANSWER_CHARS) return { ok: true, data, truncated: false };
  return { ok: true, data: text.slice(0, MAX_ANSWER_CHARS), truncated: true };
}
