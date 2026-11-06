import { describe, expect, it } from 'vitest';
import { Person, PersonId, Space, SpaceRef, TeamId, parseSpaceRef, spaceIdOf, spaceRefOf } from '../src/index.ts';

// P20-01: the Space type. A space is `person:<id>` (Personal) or `team:<id>`; the string and the object convert both ways.

const personId = PersonId.parse('00000000-0000-7000-8000-0000000c0002');
const teamId = TeamId.parse('00000000-0000-7000-8000-0000000b0001');

describe('Space', () => {
  it('is a person or a team, nothing else', () => {
    expect(Space.parse({ kind: 'person', personId })).toEqual({ kind: 'person', personId });
    expect(Space.parse({ kind: 'team', teamId })).toEqual({ kind: 'team', teamId });
    expect(Space.safeParse({ kind: 'workspace', id: personId }).success).toBe(false);
    expect(Space.safeParse({ kind: 'person', teamId }).success).toBe(false);
    expect(Space.safeParse({ kind: 'team', teamId: 'nope' }).success).toBe(false);
  });

  it('turns into a string and back', () => {
    const mine: Space = { kind: 'person', personId };
    const theirs: Space = { kind: 'team', teamId };
    expect(spaceRefOf(mine)).toBe(`person:${personId}`);
    expect(spaceRefOf(theirs)).toBe(`team:${teamId}`);
    expect(parseSpaceRef(spaceRefOf(mine))).toEqual(mine);
    expect(parseSpaceRef(spaceRefOf(theirs))).toEqual(theirs);
    expect(spaceIdOf(mine)).toBe(personId);
    expect(spaceIdOf(theirs)).toBe(teamId);
  });

  it('reads an upper-case id as the lower-case one and refuses malformed text without throwing', () => {
    expect(parseSpaceRef(`team:${teamId.toUpperCase()}`)).toEqual({ kind: 'team', teamId });
    for (const bad of ['', 'team', 'team:', 'team:123', `workspace:${teamId}`, `person:${personId}x`, ` team:${teamId}`, `team:${teamId}:x`]) {
      expect(SpaceRef.safeParse(bad).success, bad).toBe(false);
      expect(parseSpaceRef(bad), bad).toBeUndefined();
    }
  });
});

describe('Person.suspendedAt', () => {
  const base = {
    id: personId,
    workspaceId: '00000000-0000-7000-8000-00000000a001',
    displayName: 'Nadia',
    primaryEmail: 'nadia@kahf.example',
    status: 'active',
    createdAt: '2026-11-06T08:00:00.000Z',
    updatedAt: '2026-11-06T08:00:00.000Z',
  };
  it('is null for an older answer that does not carry it, and an instant once deactivated', () => {
    expect(Person.parse(base).suspendedAt).toBeNull();
    expect(Person.parse({ ...base, status: 'suspended', suspendedAt: '2026-11-06T09:00:00.000Z' }).suspendedAt).toBe('2026-11-06T09:00:00.000Z');
  });
});
