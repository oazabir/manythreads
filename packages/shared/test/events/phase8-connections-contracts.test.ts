import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  CONNECTION_KINDS,
  Connection,
  CreateConnectionRequest,
  PutConnectionCredentialRequest,
  UpdateConnectionRequest,
  connectionKindInfo,
  eventRegistry,
  parseEvent,
} from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P8-06 (`pnpm test:events`): the one connection event (ids, the short name, the kind and what kind of change: never a credential or a display name),
// the shapes of the routes' bodies, and the list of kinds the Add connection flow shows.

const AT = '2026-11-02T08:00:00.000Z';
const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};
const event = {
  type: 'connections.connection.changed',
  schemaVersion: 1,
  workspaceId: uuid(1),
  teamId: uuid(2),
  connectionId: uuid(3),
  slug: 'support-mail',
  kind: 'email',
  scope: 'team',
  change: 'credential_set',
  actorId: uuid(4),
  at: AT,
};

describe('the connection event', () => {
  it('is registered at version 1 and round-trips, for a team connection and for a person one', () => {
    expect(Object.keys(eventRegistry['connections.connection.changed'])).toEqual(['1']);
    expect(parseEvent(event)).toEqual(event);
    const mine = { ...event, teamId: null, scope: 'person', change: 'deleted' };
    expect(parseEvent(mine)).toEqual(mine);
  });

  it.each([
    ['change', { change: 'read_back' }],
    ['slug', { slug: 'Not A Slug' }],
    ['scope', { scope: 'planet' }],
    ['actorId', { actorId: 'x' }],
  ])('refuses a bad %s', (field, patch) => {
    expect(failsAt({ ...event, ...patch })).toContain(field);
  });
});

describe('the bodies', () => {
  it('create takes a kind and a name, and nothing that could carry a credential', () => {
    expect(CreateConnectionRequest.safeParse({ kind: 'email', name: 'Support mailbox' }).success).toBe(true);
    expect(CreateConnectionRequest.safeParse({ kind: 'email', name: 'Support mailbox', password: 'x' }).success).toBe(false);
    expect(CreateConnectionRequest.safeParse({ kind: 'email', name: ' ' }).success).toBe(false);
    expect(CreateConnectionRequest.safeParse({ kind: 'email', name: 'x'.repeat(81) }).success).toBe(false);
  });

  it('update changes only the name, the switch, the environment and the end date', () => {
    expect(UpdateConnectionRequest.safeParse({ status: 'enabled', expiresAt: null }).success).toBe(true);
    expect(UpdateConnectionRequest.safeParse({ kind: 'github' }).success).toBe(false);
    expect(UpdateConnectionRequest.safeParse({ slug: 'other' }).success).toBe(false);
  });

  it('a credential is a non-empty value and nothing else', () => {
    expect(PutConnectionCredentialRequest.safeParse({ value: 'secret' }).success).toBe(true);
    expect(PutConnectionCredentialRequest.safeParse({ value: '' }).success).toBe(false);
    expect(PutConnectionCredentialRequest.safeParse({ value: 'a', name: 'b' }).success).toBe(false);
  });

  it('a connection as read has no field a credential could ride in', () => {
    const shape = Object.keys(Connection.shape);
    expect(shape).not.toContain('credentials');
    expect(shape).not.toContain('secret');
    expect(shape).not.toContain('password');
  });
});

describe('the kinds the Add connection flow shows', () => {
  it('say why a kind that is not available cannot be added, and only those', () => {
    for (const k of CONNECTION_KINDS) expect(k.available === (k.unavailableReason === undefined), k.kind).toBe(true);
  });

  it('are found by kind, and the SSH and Kubernetes brokers are available', () => {
    expect(connectionKindInfo('email')?.available).toBe(true);
    expect(connectionKindInfo('kubernetes')?.available).toBe(true);
    expect(connectionKindInfo('ssh')?.available).toBe(true);
    expect(connectionKindInfo('nothing')).toBeUndefined();
  });
});
