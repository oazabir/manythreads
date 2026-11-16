import type { K8s, K8sObject } from '../src/k8s.ts';

// An in-memory Kubernetes API with server-side-apply semantics (same object in, same object out): the stand-in the controller tests run against.

export class FakeK8s implements K8s {
  readonly store = new Map<string, K8sObject>();
  applied: string[] = [];
  /** `kind/ns/name` keys whose read throws (a momentary API error). */
  failReads = new Set<string>();
  private key(kind: string, ns: string, name: string): string {
    return `${kind}/${ns}/${name}`;
  }
  async apply(obj: K8sObject): Promise<void> {
    this.store.set(this.key(obj.kind, obj.metadata.namespace!, obj.metadata.name), structuredClone(obj));
    this.applied.push(`${obj.kind}/${obj.metadata.name}`);
  }
  async get(kind: string, ns: string, name: string): Promise<K8sObject | null> {
    if (this.failReads.has(this.key(kind, ns, name))) throw new Error('connection reset');
    const o = this.store.get(this.key(kind, ns, name));
    if (!o) return null;
    // the API answers Secrets with base64 `data`, never `stringData`
    if (kind === 'Secret' && o['stringData']) {
      const data = Object.fromEntries(Object.entries(o['stringData'] as Record<string, string>).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
      return { ...o, data };
    }
    return structuredClone(o);
  }
  async delete(kind: string, ns: string, name: string): Promise<void> {
    this.store.delete(this.key(kind, ns, name));
  }
  async list(kind: string, ns: string, selector: string): Promise<K8sObject[]> {
    const wanted = selector.split(',').map((s) => s.split('='));
    return [...this.store.values()].filter(
      (o) => o.kind === kind && o.metadata.namespace === ns && wanted.every(([k, v]) => o.metadata.labels?.[k!] === v),
    );
  }
}
