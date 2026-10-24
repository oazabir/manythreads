import { describe, expect, it } from 'vitest';
import {
  BotFrontmatter,
  CreateHermesConnectionRequest,
  HermesConnection,
  eventRegistry,
  parseEvent,
} from '../src/index.ts';

const base = { name: 'Coder', role: 'r', kind: 'agent', runtime: 'hermes' };
const WS = '00000000-0000-7000-8000-00000000a001';
const TEAM = '00000000-0000-7000-8000-0000000b0001';
const ACTOR = '00000000-0000-7000-8000-0000000d0002';
const CONN = '00000000-0000-7000-8000-0000000c0001';

describe('placement.gateway', () => {
  it('mode A names a connection and a profile; mode B names only the managed connection', () => {
    expect(BotFrontmatter.safeParse({ ...base, placement: { gateway: { connection: 'host', profile: 'coder' } } }).success).toBe(true);
    expect(BotFrontmatter.safeParse({ ...base, placement: { gateway: { connection: 'managed' } } }).success).toBe(true);
  });

  it('refuses a managed placement with a profile, an own connection without one, and a mix with the legacy runner or node', () => {
    expect(BotFrontmatter.safeParse({ ...base, placement: { gateway: { connection: 'managed', profile: 'x' } } }).success).toBe(false);
    expect(BotFrontmatter.safeParse({ ...base, placement: { gateway: { connection: 'host' } } }).success).toBe(false);
    expect(BotFrontmatter.safeParse({ ...base, placement: { runner: 'box', gateway: { connection: 'managed' } } }).success).toBe(false);
    expect(BotFrontmatter.safeParse({ ...base, placement: { node: 'box', gateway: { connection: 'managed' } } }).success).toBe(false);
    expect(BotFrontmatter.safeParse({ ...base, placement: { gateway: { connection: 'host', profile: 'bad profile' } } }).success).toBe(false);
    expect(BotFrontmatter.safeParse({ ...base, placement: { gateway: { connection: 'host', profile: 'p', extra: 1 } } }).success).toBe(false);
  });

  it('the legacy runner placement still parses', () => {
    expect(BotFrontmatter.safeParse({ ...base, placement: { runner: 'box' } }).success).toBe(true);
  });
});

describe('Hermes connection schemas', () => {
  it('a connection never carries the key, only whether there is one', () => {
    const shape = Object.keys(HermesConnection.shape);
    expect(shape).toContain('hasApiKey');
    expect(shape).not.toContain('apiKey');
  });

  it('client requests are strict and the address is a plain http(s) address', () => {
    const ok = { name: 'host', baseUrl: 'http://10.42.0.1:8642', apiKey: 'a-long-enough-key' };
    expect(CreateHermesConnectionRequest.safeParse(ok).success).toBe(true);
    expect(CreateHermesConnectionRequest.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(CreateHermesConnectionRequest.safeParse({ ...ok, name: 'managed' }).success).toBe(false);
    expect(CreateHermesConnectionRequest.safeParse({ ...ok, baseUrl: 'http://u:p@host' }).success).toBe(false);
    expect(CreateHermesConnectionRequest.safeParse({ ...ok, baseUrl: 'http://host/?k=1' }).success).toBe(false);
  });
});

describe('Hermes events are registered at version 1', () => {
  it.each(['hermes.connection.created', 'hermes.connection.updated', 'hermes.connection.deleted', 'hermes.connection.tested', 'hermes.profiles.changed', 'bots.pairing.rotated'])('%s', (type) => {
    expect(Object.keys(eventRegistry)).toContain(type);
  });

  it('parses a tested connection and a profiles-changed notice, and refuses extra shapes', () => {
    const at = '2026-10-24T10:00:00.000Z';
    expect(parseEvent({ type: 'hermes.connection.tested', schemaVersion: 1, workspaceId: WS, teamId: TEAM, connectionId: CONN, name: 'host', ok: true, actorId: ACTOR, at })).toMatchObject({ ok: true });
    expect(parseEvent({ type: 'hermes.profiles.changed', schemaVersion: 1, workspaceId: WS, teamId: TEAM, at })).toMatchObject({ teamId: TEAM });
    expect(() => parseEvent({ type: 'hermes.profiles.changed', schemaVersion: 1, workspaceId: WS, at })).toThrow();
  });
});
