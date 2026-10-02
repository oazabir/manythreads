import { randomUUID } from 'node:crypto';
import { ExtensionRegistries, createMemoryKv, createPluginContext } from '@manythreads/kernel';
import { definePlugin, type PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { pushMessageDeleted, pushReaction } from '../src/service.ts';

// P4-00: the audience fan-out of a channel is one publish statement, however many people can read the channel.

const { manifest } = definePlugin({ manifest: { name: 'channels', version: '0.1.0', kind: 'server' }, register: () => undefined });
const ctx = createPluginContext(manifest, {
  registries: new ExtensionRegistries(),
  storage: createMemoryKv(),
  mail: { send: () => Promise.resolve() },
  runtime: { publicUrl: 'http://x', now: () => new Date() },
});

describe('channel fan-out', () => {
  it('a push to a 2,000-member audience issues one statement (and the typing/reaction paths share it)', async () => {
    const statements: string[] = [];
    const tx = {
      actor: { kind: 'person', id: randomUUID(), workspaceId: randomUUID() },
      query: (text: string) => {
        statements.push(text);
        return Promise.resolve({ rows: [] });
      },
    } as PluginTx;
    const people = Array.from({ length: 2_000 }, () => randomUUID());
    await pushMessageDeleted({ ctx }, tx, people, { channelId: randomUUID(), messageId: randomUUID(), threadRootId: null } as never);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('pg_notify');
    await pushReaction({ ctx }, tx, people, { channelId: randomUUID(), messageId: randomUUID(), emoji: 'x', reactions: [] } as never);
    expect(statements).toHaveLength(2);
  });
});
