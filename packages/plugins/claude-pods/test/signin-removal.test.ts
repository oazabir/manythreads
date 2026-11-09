import type { K8s, K8sObject } from '@manythreads/sdk/pods';
import { describe, expect, it } from 'vitest';
import { configFrom, type ClaudePodConfig } from '../src/config.ts';
import { providerFor } from '../src/index.ts';
import { namesFor } from '../src/render.ts';

// P19-12: "Remove sign-in" must leave no login behind. The pod keeps a second copy of the login in its state volume (the tool renews it there), so deleting only the Secret
// would leave a working login on disk for good. Every byte below is made up.

class MiniK8s implements K8s {
  readonly store = new Map<string, K8sObject>();
  failDelete: string | null = null;
  readonly calls: string[] = [];
  private key = (kind: string, ns: string, name: string): string => `${kind}/${ns}/${name}`;
  async apply(obj: K8sObject): Promise<void> {
    this.store.set(this.key(obj.kind, obj.metadata.namespace!, obj.metadata.name), structuredClone(obj));
  }
  async get(kind: string, ns: string, name: string): Promise<K8sObject | null> {
    return structuredClone(this.store.get(this.key(kind, ns, name)) ?? null);
  }
  async delete(kind: string, ns: string, name: string): Promise<void> {
    this.calls.push(`delete ${kind}/${name}`);
    if (this.failDelete === kind) throw new Error(`delete ${kind}/${name}: 500`);
    this.store.delete(this.key(kind, ns, name));
  }
  async list(): Promise<K8sObject[]> {
    return [];
  }
  async listNodes(): Promise<K8sObject[]> {
    return [];
  }
}

const CFG: ClaudePodConfig = { ...configFrom({}), namespace: 'bots', image: 'manythreads/claude-pod:1' };
const claim = (name: string): K8sObject => ({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace: 'bots' }, spec: {} });

function setup() {
  const k8s = new MiniK8s();
  const provider = providerFor(() => ({}) as never, () => k8s, CFG);
  return { k8s, provider };
}

async function seed(k8s: MiniK8s, runnerName: string, agent: 'claude' | 'codex'): Promise<ReturnType<typeof namesFor>> {
  const names = namesFor(runnerName, agent);
  await k8s.apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: names.credentials, namespace: 'bots' }, data: { [names.file]: Buffer.from('CANARY-REMOVE-5e21').toString('base64') } });
  await k8s.apply(claim(names.state));
  await k8s.apply(claim(names.work));
  return names;
}

const has = (k8s: MiniK8s, kind: string, name: string): boolean => k8s.store.has(`${kind}/bots/${name}`);

describe('removeCredentials', () => {
  it.each(['claude', 'codex'] as const)('leaves neither the credentials Secret nor the state volume of a %s runner (the work volume only holds public clones)', async (agent) => {
    const { k8s, provider } = setup();
    const names = await seed(k8s, 'shared', agent);
    await provider.removeCredentials({ runnerName: 'shared', agent });
    expect(has(k8s, 'Secret', names.credentials)).toBe(false);
    expect(has(k8s, 'PersistentVolumeClaim', names.state)).toBe(false);
    expect(has(k8s, 'PersistentVolumeClaim', names.work)).toBe(true);
  });

  it('touches only that runner: another runner of the same name in the other kind, and a different runner, keep everything', async () => {
    const { k8s, provider } = setup();
    const claude = await seed(k8s, 'shared', 'claude');
    const codex = await seed(k8s, 'shared', 'codex');
    const other = await seed(k8s, 'other', 'claude');
    await provider.removeCredentials({ runnerName: 'shared', agent: 'codex' });
    expect(has(k8s, 'Secret', codex.credentials)).toBe(false);
    for (const n of [claude, other]) {
      expect(has(k8s, 'Secret', n.credentials)).toBe(true);
      expect(has(k8s, 'PersistentVolumeClaim', n.state)).toBe(true);
    }
  });

  it('deletes the state volume before the Secret, and a failure of the first leaves the Secret in place (nothing half done)', async () => {
    const { k8s, provider } = setup();
    const names = await seed(k8s, 'shared', 'claude');
    k8s.failDelete = 'PersistentVolumeClaim';
    await expect(provider.removeCredentials({ runnerName: 'shared', agent: 'claude' })).rejects.toThrow(/PersistentVolumeClaim/);
    expect(has(k8s, 'Secret', names.credentials)).toBe(true);
    k8s.failDelete = null;
    k8s.calls.length = 0;
    await provider.removeCredentials({ runnerName: 'shared', agent: 'claude' });
    expect(k8s.calls).toEqual([`delete PersistentVolumeClaim/${names.state}`, `delete Secret/${names.credentials}`]);
  });

  it('is safe to repeat and safe when nothing was ever there', async () => {
    const { provider } = setup();
    await provider.removeCredentials({ runnerName: 'never-signed-in', agent: 'claude' });
    await provider.removeCredentials({ runnerName: 'never-signed-in', agent: 'claude' });
  });
});
