import { startFakeK8s, type FakeK8s } from '@manythreads/test-utils';
import * as shared from '@manythreads/shared';
import { expect } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import type { StackApi } from '../support/stack-browser.ts';

/*
 * Shared by the three specs of the runner security proof (PLAN P19-12): a stack with the runners world (seed v19) and a stand-in of the Kubernetes API that the test owns, so a spec can
 * add a machine, read the Secrets and see which calls were made; the list of values that must never reach a person who is not an admin; and the walk over every route of the runner and
 * bot APIs. Every value here is made up.
 */

/** A machine name no response may repeat to anyone but an admin on the Machine picker. */
export const NODE_CANARY = 'canary-node-7f3a';

/** Values of the seed (packages/test-utils/src/seed-runners.ts) and of this proof that only the server may hold: an address, a key, a sign-in token. */
export const SEED_VALUES = ['192.168.50.20', 'CANARY-SEEDRUNNERS-3c8d', 'seed-hermes-key', 'fake-access-', 'fake-refresh-', NODE_CANARY] as const;
/** Names of fields that carry a sign-in detail or a secret. A non-admin response never has one of them as a key. */
export const SECRET_FIELDS = ['accessToken', 'refreshToken', 'credentials_sha256', 'credentialsSha256', 'login_id', 'loginId', 'secretId', 'secret_id', 'apiKey', 'api_key', 'mcpOAuth', 'claudeAiOauth'] as const;

export interface RunnersWorld {
  stack: Stack;
  k8s: FakeK8s;
  stop(): Promise<void>;
}

/** The stack of the `runners` seed with its own stand-in of the Kubernetes API (one machine whose name is the canary), and the server's log kept. */
export async function startRunnersWorld(env: Record<string, string> = {}): Promise<RunnersWorld> {
  const k8s = await startFakeK8s();
  k8s.nodes.push({
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name: NODE_CANARY, labels: { 'kubernetes.io/hostname': NODE_CANARY } },
    spec: {},
    status: { conditions: [{ type: 'Ready', status: 'True' }], allocatable: { cpu: '4', memory: '16Gi' }, nodeInfo: { architecture: 'amd64' } },
  });
  const stack = await startStack({
    MANYTHREADS_STACK_SEED: 'runners',
    MANYTHREADS_STACK_LOG: '1',
    MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL: k8s.url,
    MANYTHREADS_HERMES_PODS_TEST_K8S_URL: k8s.url,
    MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES: NODE_CANARY,
    ...env,
  });
  return {
    stack,
    k8s,
    stop: async () => {
      await stack.stop();
      await k8s.stop();
    },
  };
}

export interface RouteSpec {
  name: string;
  method: string;
  path: string;
}

/** The routes whose answers could carry a runner's address, key, node or sign-in. A new `*Route` under one of these prefixes is walked without anyone remembering to list it. */
export const ROUTE_PREFIXES = ['/api/admin/bot-runners', '/api/teams/:slug/bot-runners', '/api/teams/:slug/bots', '/api/teams/:slug/runners', '/api/runners', '/api/runs/self', '/api/me/bot-consents'] as const;

export function runnerRoutes(): RouteSpec[] {
  const out: RouteSpec[] = [];
  for (const [name, value] of Object.entries(shared)) {
    if (!name.endsWith('Route') || typeof value !== 'object' || value === null) continue;
    const r = value as { method?: unknown; path?: unknown };
    if (typeof r.method !== 'string' || typeof r.path !== 'string') continue;
    if (ROUTE_PREFIXES.some((p) => (r.path as string).startsWith(p))) out.push({ name, method: r.method, path: r.path });
  }
  return out.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

export interface Ids {
  runnerId: string;
  botId: string;
  slug: string;
  botSlug: string;
}

/** Fills the `:parameters` of a route. A parameter this does not know gets a made-up id (so a route with an unknown id is asked too). */
export function fill(path: string, ids: Ids): string {
  const NONE = '00000000-0000-4000-8000-000000000000';
  return path
    .replace(':slug', ids.slug)
    .replace(':botSlug', ids.botSlug)
    .replace(':botId', ids.botId)
    .replace(':runnerId', ids.runnerId)
    .replace(':id', ids.runnerId)
    .replace(/:[A-Za-z]+/g, NONE);
}

export interface Answer {
  route: string;
  status: number;
  text: string;
  headers: string;
}

/** One request as `api`, a write with an empty JSON body (the answers of a refusal are what is read, so nothing is meant to change). */
export async function ask(api: StackApi, method: string, url: string, timeout = 30_000): Promise<Answer> {
  const headers = method === 'GET' ? {} : { ...(await api.headers()), 'content-type': 'application/json' };
  const res = await api.ctx.fetch(url, { method, headers, ...(method === 'GET' ? {} : { data: '{}' }), timeout, maxRedirects: 0, failOnStatusCode: false });
  return { route: `${method} ${url}`, status: res.status(), text: await res.text(), headers: JSON.stringify(res.headers()) };
}

/** The first thing from `needles` that `text` holds, or null. */
export function foundIn(text: string, needles: readonly string[]): string | null {
  return needles.find((n) => text.includes(n)) ?? null;
}

/** A field name as a JSON key (`"apiKey":`), so a sentence that merely says "api key" is not a finding. */
export function hasKey(text: string, field: string): boolean {
  return new RegExp(`"${field}"\\s*:`).test(text);
}

export function expectNoLeak(answer: Answer, needles: readonly string[]): void {
  const hit = foundIn(`${answer.text}\n${answer.headers}`, needles);
  expect(hit, `${answer.route} (${String(answer.status)}) must not hold "${hit ?? ''}"`).toBeNull();
  for (const f of SECRET_FIELDS) expect(hasKey(answer.text, f), `${answer.route} (${String(answer.status)}) must not have a field "${f}"`).toBe(false);
}

/** What the pods namespace and the Secrets of the stand-in cluster are called: names an operator knows and a person on a team does not need. Read after the seed has made its sign-ins. */
export function podNames(k8s: FakeK8s): string[] {
  const out = new Set<string>(['.svc:8650']);
  for (const key of k8s.secrets.keys()) {
    const [ns, name] = key.split('/');
    if (ns) out.add(ns);
    if (name) out.add(name.replace(/-(credentials|key)$/, ''));
  }
  return [...out];
}
