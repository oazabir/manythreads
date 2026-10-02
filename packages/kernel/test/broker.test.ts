import { randomUUID } from 'node:crypto';
import { ActorId, TeamId, WorkspaceId, parseEvent } from '@manythreads/shared';
import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CapabilityBroker,
  CapabilityError,
  CapabilityRegistry,
  createSystemPool,
  createDbGrantSource,
  createEventAuditSink,
  createGrant,
  withSystem,
  type Actor,
  type DenialRecord,
  type GrantSource,
} from '../src/index.ts';

const workspaceId = WorkspaceId.parse(randomUUID());
const bot = (trigger?: string): Actor => ({
  kind: 'bot',
  id: ActorId.parse(randomUUID()),
  workspaceId,
  ...(trigger ? { trigger } : {}),
});
const person: Actor = { kind: 'person', id: ActorId.parse(randomUUID()), workspaceId };

function setup(granted: string[] = [], approval: string[] = []) {
  const registry = new CapabilityRegistry();
  for (const name of ['files.read', 'files.write', 'files.delete', 'files.move', 'pages.write', 'tasks.claim', 'gmail.read']) {
    registry.register({ name, destructive: false, plugin: 'test' });
  }
  registry.register({ name: 'files.purge', destructive: true, plugin: 'test' });
  const grants: GrantSource = {
    find: (_actor, capability) =>
      Promise.resolve(
        granted.includes(capability) ? { needsApproval: approval.includes(capability), constraints: {} } : undefined,
      ),
  };
  const denials: DenialRecord[] = [];
  const broker = new CapabilityBroker({ registry, grants, audit: (d) => void denials.push(d) });
  return { registry, broker, denials };
}

describe('broker: path guard (bot actors)', () => {
  const all = ['files.write', 'files.delete', 'files.move', 'pages.write'];
  const guarded = [
    'bots/x/BOT.md',
    'bots/x',
    'bots',
    'TEAM.md',
    'skills/x',
    'skills/x/SKILL.md',
    'routines/x.yaml',
    './bots/x/BOT.md',
    '/TEAM.md',
    'pages/../bots/x',
    'pages/a/../../skills/y',
    'pages//../routines/z.yaml',
    '../bots/x',
    'pages/../../bots/x',
    'bots\\x\\BOT.md',
    '%62ots/x',
    'pages/%2e%2e/bots/x',
    'pages/..%2fbots/x',
    'Bots/x.md',
    'team.md',
    'TEAM.MD',
    'Skills/x',
    'TEAM.md.',
    'pages/%252e%252e/bots/x',
    '%2e/./TEAM.md',
  ];

  for (const capability of all) {
    it.each(guarded)(`denies ${capability} on %s, and logs it`, async (path) => {
      const { broker, denials } = setup(all);
      const d = await broker.authorize(bot('conversation'), capability, { path });
      expect(d.allowed, d.reason).toBe(false);
      expect(d.needsApproval).toBe(false);
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({ capability, actorKind: 'bot', path });
    });
  }

  it('denies a grant-holding bot moving a page into a guarded folder (destination checked)', async () => {
    const { broker } = setup(all);
    const d = await broker.authorize(bot('conversation'), 'files.move', { path: 'pages/a.md', paths: ['skills/a.md'] });
    expect(d.allowed).toBe(false);
  });

  it('denies a write with no path (fail closed)', async () => {
    const { broker } = setup(all);
    expect((await broker.authorize(bot('conversation'), 'files.write')).allowed).toBe(false);
  });

  it.each(['pages/x.md', 'pages/../pages/x.md', './pages/x.md', 'docs/bots/x.md', 'docs/TEAM.md'])(
    'allows a granted write to %s (only the guarded roots)',
    async (path) => {
      const { broker, denials } = setup(all);
      const d = await broker.authorize(bot('conversation'), 'files.write', { path });
      expect(d).toEqual({ allowed: true, reason: 'granted', needsApproval: false });
      expect(denials).toHaveLength(0);
    },
  );

  it('does not guard reads of bots/', async () => {
    const { broker } = setup(['files.read']);
    expect((await broker.authorize(bot('conversation'), 'files.read', { path: 'bots/x/BOT.md' })).allowed).toBe(true);
  });

  it('only bots are guarded: system and person actors are not subject to the bot path guard', async () => {
    const { broker } = setup();
    const system: Actor = { kind: 'system', id: ActorId.parse(randomUUID()), workspaceId };
    expect((await broker.authorize(system, 'files.write', { path: 'bots/x/BOT.md' })).allowed).toBe(true);
    expect((await broker.authorize(person, 'files.write', { path: 'bots/x/BOT.md' })).allowed).toBe(true);
  });
});

describe('broker: allowlist, person scope, approvals', () => {
  it('denies a bot with no grant', async () => {
    const { broker, denials } = setup();
    const d = await broker.authorize(bot('conversation'), 'tasks.claim');
    expect(d).toMatchObject({ allowed: false });
    expect(d.reason).toMatch(/no grant/);
    expect(denials).toHaveLength(1);
  });

  it('denies unknown capabilities, even for a bot that has a grant row', async () => {
    const { broker } = setup(['nope.nothing']);
    const d = await broker.authorize(bot('conversation'), 'nope.nothing');
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/unknown capability/);
  });

  it('surfaces needsApproval from the grant', async () => {
    const { broker } = setup(['tasks.claim'], ['tasks.claim']);
    expect(await broker.authorize(bot('conversation'), 'tasks.claim')).toEqual({
      allowed: true,
      reason: 'granted',
      needsApproval: true,
    });
  });

  it.each(['routine', 'heartbeat', 'task_assigned', 'inbox', 'webhook', 'channel_message', undefined])(
    'denies person:* for trigger %s',
    async (trigger) => {
      const { broker, denials } = setup(['person:*', 'gmail.read']);
      for (const request of [
        broker.authorize(bot(trigger), 'person:*'),
        broker.authorize(bot(trigger), 'gmail.read', { constraints: { scope: 'person:*' } }),
      ]) {
        const d = await request;
        expect(d.allowed).toBe(false);
        expect(d.reason).toMatch(/conversation and mention/);
      }
      expect(denials).toHaveLength(2);
    },
  );

  it.each(['conversation', 'mention'])('allows person:* for trigger %s when granted', async (trigger) => {
    const { broker } = setup(['person:*']);
    expect((await broker.authorize(bot(trigger), 'person:*')).allowed).toBe(true);
    expect((await broker.authorize(bot(trigger), 'gmail.read', { constraints: { scope: 'person:*' } })).allowed).toBe(true);
  });

  it('takes the trigger from the context over the actor', async () => {
    const { broker } = setup(['person:*']);
    expect((await broker.authorize(bot('conversation'), 'person:*', { trigger: 'routine' })).allowed).toBe(false);
  });

  it('never allows a destructive capability to a bot, even with a stale grant row', async () => {
    const { broker } = setup(['files.purge']);
    const d = await broker.authorize(bot('conversation'), 'files.purge', { path: 'pages/x.md' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/destructive/);
  });

  it('a failing audit sink does not turn a deny into an allow', async () => {
    const { registry } = setup();
    const broker = new CapabilityBroker({
      registry,
      grants: { find: () => Promise.resolve(undefined) },
      audit: () => Promise.reject(new Error('sink down')),
    });
    expect((await broker.authorize(bot('conversation'), 'tasks.claim')).allowed).toBe(false);
  });
});

describe('capability registry and grants', () => {
  it('rejects destructive and unknown capabilities at grant time', () => {
    const { registry } = setup();
    expect(() => registry.assertGrantable(['tasks.claim', 'person:*'])).not.toThrow();
    expect(() => registry.assertGrantable(['files.purge'])).toThrow(/files\.purge.*destructive/);
    expect(() => registry.assertGrantable(['nope.nothing'])).toThrow(CapabilityError);
  });

  it('rejects malformed names and duplicates', () => {
    const { registry } = setup();
    expect(() => registry.register({ name: 'NotValid', destructive: false, plugin: 'x' })).toThrow(/namespace\.verb/);
    expect(() => registry.register({ name: 'tasks.claim', destructive: false, plugin: 'x' })).toThrow(/already registered/);
  });
});

describe('broker with Postgres grants and the event audit sink', () => {
  let db: TestDatabase;
  let pool: ReturnType<typeof createSystemPool>;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = createSystemPool(db.systemUrl, 4);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    if (db) await dropTestDatabase(db);
  }, 60_000);

  it('createGrant refuses destructive grants before writing; allowed grants authorize; denials emit an event', async () => {
    const { registry } = setup();
    const botActor = bot('conversation');
    const teamId = TeamId.parse(randomUUID());
    const opts = { pool };
    await withSystem(
      (tx) =>
        tx.query('INSERT INTO app.actors (id, kind, workspace_id, ref_id) VALUES ($1, $2, $3, $4)', [
          botActor.id,
          'bot',
          workspaceId,
          randomUUID(),
        ]),
      opts,
    );
    await expect(
      withSystem((tx) => createGrant(tx, registry, { teamId, actorId: botActor.id, capability: 'files.purge' }), opts),
    ).rejects.toThrow(/destructive/);
    await withSystem(
      (tx) =>
        createGrant(tx, registry, { teamId, actorId: botActor.id, capability: 'tasks.claim', needsApproval: true }),
      opts,
    );

    // The emit function is the kernel's `emit(tx, event)`; a recording stub keeps this test independent of it.
    const emitted: Record<string, unknown>[] = [];
    const broker = new CapabilityBroker({
      registry,
      grants: createDbGrantSource({ pool }),
      audit: createEventAuditSink(
        (_tx, event) => {
          emitted.push(event);
          return Promise.resolve();
        },
        { withTx: (fn) => withSystem(fn, opts) },
      ),
    });
    expect(await broker.authorize(botActor, 'tasks.claim')).toMatchObject({ allowed: true, needsApproval: true });
    const denied = await broker.authorize(botActor, 'files.write', { path: 'TEAM.md' });
    expect(denied.allowed).toBe(false);
    expect(emitted).toHaveLength(1);
    // The event we emit is a valid registry event (parseEvent throws, naming the field, if not).
    expect(parseEvent(emitted[0])).toMatchObject({ type: 'kernel.capability.denied', capability: 'files.write', path: 'TEAM.md' });
  });
});
