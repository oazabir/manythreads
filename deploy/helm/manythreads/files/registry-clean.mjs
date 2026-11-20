// The in-cluster registry's nightly clean-up (P31-05; templates/registry.yaml). Node 22, no dependencies: it runs in the server image.
//
//   node registry-clean.mjs clean      skip when a test-site build Job runs; delete old tags through the registry's HTTP API; when anything was
//                                      deleted, scale the registry to 0 and leave /status/gc for the garbage-collect step
//   node registry-clean.mjs scale-up   after the garbage-collect step: scale the registry back to 1 (always, when `clean` scaled it down)
//
// What is kept: everything under platform/* (the database image, pulled by digest); in every other repository the newest KEEP_TAGS tags (by the image's
// `created` time) and any tag or digest a pod in a deploy target uses; in a `<namespace>/cache` repository (kaniko's layer cache) an entry whose
// layers are all part of a kept image (it costs no space) or that is younger than KEEP_CACHE_DAYS (kaniko itself ignores entries older than its
// --cache-ttl, two weeks by default, so an older one is dead weight). A digest that a kept tag points at is never deleted. An image whose time
// cannot be read stops the run: guessing could delete the newest tag.
// The garbage collection that follows never runs with --delete-untagged (MISTAKES.md: it removed the database index's child manifests).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const MANIFEST_TYPES = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
].join(', ');
const INDEX_TYPES = new Set(['application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.oci.image.index.v1+json']);

/**
 * Decide what to delete. Pure: the tests call it with made-up registries.
 * @param {{ repo: string, tag: string, digest: string, created: string, layers: string[], index: boolean }[]} entries every tag of every repository
 * @param {{ tags: Set<string>, digests: Set<string> }} inUse `<repo>:<tag>` and `sha256:…` that pods use
 * @param {{ keepTags: number, keepCacheDays: number, now: number }} keep
 * @returns {{ repo: string, digest: string, tags: string[] }[]} the manifests to delete
 */
export function plan(entries, inUse, keep) {
  const byRepo = new Map();
  for (const e of entries) byRepo.set(e.repo, [...(byRepo.get(e.repo) ?? []), e]);
  const newestFirst = (a, b) => (b.created || '').localeCompare(a.created || '');
  const kept = new Set();
  const isCache = (repo) => repo.endsWith('/cache');
  for (const [repo, list] of byRepo) {
    if (isCache(repo)) continue;
    const sorted = [...list].sort(newestFirst);
    sorted.forEach((e, i) => {
      if (repo.startsWith('platform/') || e.index || i < keep.keepTags || inUse.tags.has(`${repo}:${e.tag}`) || inUse.digests.has(e.digest)) kept.add(e);
    });
  }
  const keptLayers = new Set([...kept].flatMap((e) => e.layers));
  for (const [repo, list] of byRepo) {
    if (!isCache(repo)) continue;
    const cutoff = keep.now - keep.keepCacheDays * 86_400_000;
    for (const e of list) {
      const t = Date.parse(e.created);
      if (e.index || !(t < cutoff) || (e.layers.length > 0 && e.layers.every((l) => keptLayers.has(l)))) kept.add(e);
    }
  }
  const keptDigests = new Set([...kept].map((e) => `${e.repo}@${e.digest}`));
  const out = new Map();
  for (const e of entries) {
    if (kept.has(e) || keptDigests.has(`${e.repo}@${e.digest}`)) continue;
    const k = `${e.repo}@${e.digest}`;
    out.set(k, { repo: e.repo, digest: e.digest, tags: [...(out.get(k)?.tags ?? []), e.tag] });
  }
  return [...out.values()];
}

/** `registry.local:5000/test-manythreads/server:abc` → `test-manythreads/server:abc`; a digest (`…@sha256:…`) → the digest. */
export function refsOf(image, pullHosts) {
  const at = image.indexOf('@');
  const digest = at >= 0 ? image.slice(at + 1) : undefined;
  let name = at >= 0 ? image.slice(0, at) : image;
  const host = pullHosts.find((h) => name.startsWith(`${h}/`));
  if (!host) return { digest };
  name = name.slice(host.length + 1);
  const colon = name.lastIndexOf(':');
  return { tag: colon > 0 ? name : undefined, digest };
}

const env = (k, d) => process.env[k] ?? d;
const REGISTRY = env('REGISTRY_URL', 'http://registry:5000');
const PULL_HOSTS = env('REGISTRY_PULL_HOSTS', 'registry.local:5000').split(/\s+/).filter(Boolean);
const TARGETS = env('TARGET_NAMESPACES', '').split(/\s+/).filter(Boolean);
const REGISTRY_NS = env('REGISTRY_NAMESPACE', 'manythreads-registry');
const STATUS = env('STATUS_DIR', '/status');
const API = `https://${env('KUBERNETES_SERVICE_HOST', 'kubernetes.default.svc')}:${env('KUBERNETES_SERVICE_PORT', '443')}`;
const TOKEN_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/token';

// A new pod's network policy takes a few seconds to reach the node (k3s: the first connections are refused, seen live on 2026-11-20): retry a
// call that did not connect for up to a minute. Only connection errors are retried, never an HTTP answer.
async function fetchRetry(url, init) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (i >= 30) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function kube(path, init = {}) {
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  const r = await fetchRetry(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function reg(path, init = {}) {
  const r = await fetchRetry(`${REGISTRY}${path}`, init);
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status}`);
  return r;
}

const scale = (replicas) =>
  kube(`/apis/apps/v1/namespaces/${REGISTRY_NS}/deployments/registry/scale`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify({ spec: { replicas } }),
  });

async function registryPods() {
  const l = await kube(`/api/v1/namespaces/${REGISTRY_NS}/pods?labelSelector=${encodeURIComponent('app.kubernetes.io/component=registry')}`);
  return l.items;
}

async function waitFor(what, test, seconds) {
  for (let i = 0; i < seconds / 2; i++) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function clean() {
  const keep = { keepTags: Number(env('KEEP_TAGS', '2')), keepCacheDays: Number(env('KEEP_CACHE_DAYS', '14')), now: Date.now() };
  if (!(keep.keepTags >= 1) || !(keep.keepCacheDays >= 1)) throw new Error('KEEP_TAGS and KEEP_CACHE_DAYS must be at least 1');
  const inUse = { tags: new Set(), digests: new Set() };
  for (const ns of TARGETS) {
    const jobs = await kube(`/apis/batch/v1/namespaces/${ns}/jobs?labelSelector=${encodeURIComponent('app.kubernetes.io/name=manythreads-preview-build')}`);
    const running = jobs.items.filter((j) => (j.status?.active ?? 0) > 0).map((j) => j.metadata.name);
    if (running.length) {
      console.log(`a test-site build is running in ${ns} (${running.join(', ')}): nothing is cleaned tonight`);
      return;
    }
    const pods = await kube(`/api/v1/namespaces/${ns}/pods`);
    for (const p of pods.items) {
      const images = [...(p.spec.initContainers ?? []), ...(p.spec.containers ?? [])].map((c) => c.image);
      const ids = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])].flatMap((s) => [s.image, s.imageID]);
      for (const img of [...images, ...ids].filter(Boolean)) {
        const r = refsOf(img, PULL_HOSTS);
        if (r.tag) inUse.tags.add(r.tag);
        if (r.digest) inUse.digests.add(r.digest);
      }
    }
  }
  const entries = [];
  const { repositories } = await (await reg('/v2/_catalog?n=1000')).json();
  for (const repo of repositories ?? []) {
    const { tags } = await (await reg(`/v2/${repo}/tags/list`)).json();
    for (const tag of tags ?? []) {
      const r = await reg(`/v2/${repo}/manifests/${tag}`, { headers: { accept: MANIFEST_TYPES } });
      const digest = r.headers.get('docker-content-digest');
      const m = await r.json();
      const index = INDEX_TYPES.has(m.mediaType ?? r.headers.get('content-type'));
      let created = '';
      if (!index) {
        if (!m.config?.digest) throw new Error(`${repo}:${tag} has no config: not guessing its age`);
        created = (await (await reg(`/v2/${repo}/blobs/${m.config.digest}`)).json()).created ?? '';
        if (Number.isNaN(Date.parse(created))) throw new Error(`${repo}:${tag} has no readable creation time: not guessing its age`);
      }
      if (!digest) throw new Error(`${repo}:${tag} has no digest header`);
      entries.push({ repo, tag, digest, created, layers: (m.layers ?? []).map((l) => l.digest), index });
    }
  }
  const doomed = plan(entries, inUse, keep);
  console.log(`${entries.length} tags in ${repositories?.length ?? 0} repositories; ${doomed.length} manifests to delete`);
  for (const d of doomed) {
    await reg(`/v2/${d.repo}/manifests/${d.digest}`, { method: 'DELETE' });
    console.log(`deleted ${d.repo} ${d.tags.join(', ')} (${d.digest.slice(0, 19)})`);
  }
  if (!doomed.length) return;
  writeFileSync(`${STATUS}/gc`, 'scaled down\n');
  try {
    await scale(0);
    await waitFor('the registry pod to stop', async () => (await registryPods()).length === 0, 180);
  } catch (e) {
    await scale(1);
    throw e;
  }
  console.log('registry stopped; the garbage collection runs next');
}

async function scaleUp() {
  if (!existsSync(`${STATUS}/gc`)) {
    console.log('nothing was deleted; the registry was not stopped');
    return;
  }
  await scale(1);
  await waitFor(
    'the registry to be ready',
    async () => (await registryPods()).some((p) => p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')),
    180,
  );
  console.log('registry running again');
  if (existsSync(`${STATUS}/gc-failed`)) throw new Error('the garbage collection failed (its log is in the gc container)');
}

const cmd = process.argv[2];
if (cmd === 'clean' || cmd === 'scale-up') {
  (cmd === 'clean' ? clean() : scaleUp()).catch((e) => {
    console.error(String(e?.stack ?? e));
    process.exit(1);
  });
}
