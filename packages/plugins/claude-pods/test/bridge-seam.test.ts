import type { K8s, K8sObject } from '@manythreads/sdk/pods';
import { afterEach, describe, expect, it } from 'vitest';
import { configFrom } from '../src/config.ts';
import { providerFor } from '../src/index.ts';
import { namesFor } from '../src/render.ts';

// P19-12: the test seam that lets a test server point the runners' bridges at one stand-in. It must do nothing in a real install: both variables are needed and NODE_ENV must be `test`.

const keySecret = (name: string): K8sObject => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name: namesFor(name, 'claude').key, namespace: 'bots' }, data: { 'api-key': Buffer.from('real-pod-key').toString('base64') } });
const k8s = (withKey: boolean): K8s => ({
  apply: async () => undefined,
  get: async (kind) => (kind === 'Secret' && withKey ? keySecret('shared') : null),
  delete: async () => undefined,
  list: async () => [],
  listNodes: async () => [],
});
const provider = (withKey: boolean) => providerFor(() => ({}) as never, () => k8s(withKey), { ...configFrom({}), namespace: 'bots' });

const saved = { env: process.env['NODE_ENV'], url: process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL'], key: process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY'] };
const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
afterEach(() => {
  restore('NODE_ENV', saved.env);
  restore('MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL', saved.url);
  restore('MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY', saved.key);
});

describe('the bridge address of a pod', () => {
  it('is the Service of the pod and the key of its Secret when no seam is set', async () => {
    delete process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL'];
    delete process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY'];
    expect(await provider(true).bridge({ runnerName: 'shared', agent: 'claude' })).toEqual({ address: 'http://claude-shared.bots.svc:8650', key: 'real-pod-key' });
    expect(await provider(false).bridge({ runnerName: 'shared', agent: 'claude' })).toBeNull();
  });

  it('is the stand-in when a test server sets both variables', async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL'] = 'http://127.0.0.1:9';
    process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY'] = 'stand-in-key';
    expect(await provider(false).bridge({ runnerName: 'shared', agent: 'claude' })).toEqual({ address: 'http://127.0.0.1:9', key: 'stand-in-key' });
  });

  it('ignores the variables outside a test server, and when only one is set', async () => {
    process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL'] = 'http://127.0.0.1:9';
    process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY'] = 'stand-in-key';
    process.env['NODE_ENV'] = 'production';
    expect(await provider(true).bridge({ runnerName: 'shared', agent: 'claude' })).toEqual({ address: 'http://claude-shared.bots.svc:8650', key: 'real-pod-key' });
    process.env['NODE_ENV'] = 'test';
    delete process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY'];
    expect(await provider(true).bridge({ runnerName: 'shared', agent: 'claude' })).toEqual({ address: 'http://claude-shared.bots.svc:8650', key: 'real-pod-key' });
  });
});
