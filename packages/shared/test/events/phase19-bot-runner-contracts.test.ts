import { describe, expect, it } from 'vitest';
import { BotRunner, CreateBotRunnerRequest, SetRunnerNodeRequest, TeamBotRunner, UpdateBotRunnerRequest, eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P19-02 (`pnpm test:events`): the seven runner events have a registered v1 schema that accepts the documented payload and refuses what breaks
// it. They say that something happened and to which runner (by id and name), never an address, a key, a node or a sign-in. The bot-runners plugin's own tests
// prove the real code path writes these shapes.

const at = '2026-11-02T09:00:00.000Z';
const base = { schemaVersion: 1, workspaceId: uuid(1), at };
const samples = {
  'bot_runner.runner.created': { ...base, type: 'bot_runner.runner.created', runnerId: uuid(2), name: 'host', kind: 'hermes_gateway', adopted: false, actorId: uuid(4) },
  'bot_runner.runner.updated': { ...base, type: 'bot_runner.runner.updated', runnerId: uuid(2), name: 'host', changed: ['address', 'key'], actorId: uuid(4) },
  'bot_runner.runner.deleted': { ...base, type: 'bot_runner.runner.deleted', runnerId: uuid(2), name: 'host', kind: 'hermes_pod', actorId: uuid(4) },
  'bot_runner.runner.tested': { ...base, type: 'bot_runner.runner.tested', runnerId: uuid(2), name: 'host', ok: true, actorId: uuid(4) },
  'bot_runner.availability.changed': { ...base, type: 'bot_runner.availability.changed', runnerId: uuid(2), name: 'host', enabled: true, allTeams: false, teamCount: 3, actorId: uuid(4) },
  'bot_runner.default.changed': { ...base, type: 'bot_runner.default.changed', runnerId: uuid(2), previousRunnerId: null, actorId: uuid(4) },
  'bot_runner.node.changed': { ...base, type: 'bot_runner.node.changed', runnerId: uuid(2), name: 'team-pod', wasPinned: false, isPinned: true, recreatesWorkVolume: true, actorId: uuid(4) },
  'bot_runner.terms.accepted': { ...base, type: 'bot_runner.terms.accepted', runnerId: uuid(2), name: 'claude-max', acceptedBy: uuid(4) },
  'bot_runner.run.refused': { ...base, type: 'bot_runner.run.refused', teamId: uuid(5), botId: uuid(6), runId: uuid(7), runner: 'host', reason: 'disabled' },
  'bot_runner.run.unmetered': { ...base, type: 'bot_runner.run.unmetered', teamId: uuid(5), botId: uuid(6), runId: uuid(7), runner: 'team-pod' },
} as const;

describe.each(Object.entries(samples))('%s', (type, valid) => {
  it('is registered at version 1 and parses its payload', () => {
    expect(latestVersion(type as keyof typeof eventRegistry)).toBe(1);
    expect(Object.keys(eventRegistry[type as keyof typeof eventRegistry])).toEqual(['1']);
    expect(parseEvent(valid)).toMatchObject({ type });
  });

  it('refuses a missing field (only the ones that may be null stay optional) and another schema version', () => {
    for (const key of Object.keys(valid).filter((k) => k !== 'type' && k !== 'schemaVersion')) {
      expect(() => parseEvent({ ...valid, [key]: undefined }), key).toThrow();
    }
    expect(() => parseEvent({ ...valid, schemaVersion: 2 })).toThrow();
  });

  it('carries no address, key, node or text: extra fields do not come through', () => {
    const parsed = parseEvent({ ...valid, baseUrl: 'http://10.0.0.5:8642', apiKey: 'sk-secret', node: 'worker-1', body: 'text' }) as unknown as Record<string, unknown>;
    for (const key of ['baseUrl', 'apiKey', 'node', 'body']) expect(parsed[key], key).toBeUndefined();
  });
});

describe('the names of the events', () => {
  it('have three parts, as every event has', () => {
    for (const type of Object.keys(samples)) expect(type.split('.').length).toBeGreaterThanOrEqual(3);
  });

  it('bot_runner.runner.updated names a setting that changed, from a fixed list, and at least one', () => {
    expect(() => parseEvent({ ...samples['bot_runner.runner.updated'], changed: [] })).toThrow();
    expect(() => parseEvent({ ...samples['bot_runner.runner.updated'], changed: ['http://10.0.0.5'] })).toThrow();
  });

  it('bot_runner.default.changed may name no runner at all (no default now)', () => {
    expect(parseEvent({ ...samples['bot_runner.default.changed'], runnerId: null, previousRunnerId: uuid(2) })).toMatchObject({ runnerId: null });
  });
});

describe('bot_runner.run.refused (P19-03)', () => {
  it('names a reason from a fixed list only', () => {
    expect(() => parseEvent({ ...samples['bot_runner.run.refused'], reason: 'http://10.0.0.5 refused' })).toThrow();
    for (const reason of ['unknown', 'disabled', 'not_available_to_team', 'not_runnable', 'not_set_up', 'not_ready']) {
      expect(parseEvent({ ...samples['bot_runner.run.refused'], reason })).toMatchObject({ reason });
    }
  });
});

describe('the runner shapes', () => {
  it('what an admin reads says whether there is a key and never holds one', () => {
    const shape = Object.keys(BotRunner.shape);
    expect(shape).toContain('hasKey');
    for (const bad of ['apiKey', 'key', 'secret', 'secretId', 'token', 'loginId', 'credentials']) expect(shape, bad).not.toContain(bad);
  });

  it('what a team member reads has eight fields: no address, key, node or expiry', () => {
    expect(Object.keys(TeamBotRunner.shape).sort()).toEqual(['isDefault', 'kind', 'label', 'name', 'ownerName', 'planLabel', 'sharedWith', 'status']);
  });

  it('a request is strict: an unknown field, a bad name or a kind that is not one are refused', () => {
    const ok = { name: 'host', label: 'Office', kind: 'hermes_gateway', baseUrl: 'http://10.0.0.5:8642', apiKey: 'a-key-0123456789' };
    expect(CreateBotRunnerRequest.safeParse(ok).success).toBe(true);
    expect(CreateBotRunnerRequest.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(CreateBotRunnerRequest.safeParse({ ...ok, name: 'Host Name' }).success).toBe(false);
    expect(CreateBotRunnerRequest.safeParse({ ...ok, kind: 'made_up' }).success).toBe(false);
    expect(CreateBotRunnerRequest.safeParse({ ...ok, apiKey: 'short' }).success).toBe(false);
    expect(CreateBotRunnerRequest.safeParse({ ...ok, baseUrl: 'http://u:p@host' }).success).toBe(false);
  });
});

describe('the node routes (P19-08)', () => {
  it('bot_runner.node.changed carries three booleans and no machine name', () => {
    const parsed = parseEvent({ ...samples['bot_runner.node.changed'], node: 'ubuntu-vm', from: 'a', to: 'b' }) as unknown as Record<string, unknown>;
    for (const key of ['node', 'from', 'to']) expect(parsed[key], key).toBeUndefined();
    expect(parsed['wasPinned']).toBe(false);
  });

  it('a machine name is a label value: letters, digits, "-", "_" and ".", at most 63 characters', () => {
    for (const ok of ['ubuntu-vm', 'node1', 'a', 'worker_1.lan']) expect(SetRunnerNodeRequest.safeParse({ node: ok }).success, ok).toBe(true);
    for (const bad of ['', '-x', 'x-', 'a b', 'a/b', 'x'.repeat(64), 'node;rm', '{"a":1}']) expect(SetRunnerNodeRequest.safeParse({ node: bad }).success, bad).toBe(false);
    expect(SetRunnerNodeRequest.safeParse({ node: null }).success).toBe(true);
    expect(SetRunnerNodeRequest.safeParse({ node: 'ubuntu-vm', extra: 1 }).success).toBe(false);
  });

  it('a runner is no longer made or changed with a node by the generic routes', () => {
    expect(CreateBotRunnerRequest.safeParse({ name: 'pod', label: 'Pod', kind: 'hermes_pod', node: 'ubuntu-vm' }).success).toBe(false);
    expect(UpdateBotRunnerRequest.safeParse({ node: 'ubuntu-vm' }).success).toBe(false);
  });
});
