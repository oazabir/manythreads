import type { Actor } from '@manythreads/kernel';
import type { ActorId, PersonId, TeamId, TeamRole, WorkspaceId, WorkspaceRole } from '@manythreads/shared';

export type { TeamRole, WorkspaceRole };
export type TeamName = 'Engineering' | 'Customer support' | 'Marketing';

export interface PersonaTeamMembership {
  team: TeamName;
  role: TeamRole;
  /** Role tags from TEAM.md, e.g. `role:on-call`. */
  tags: string[];
}

/** One of the seven personas of PLAN.md section 4. `createPersonas(db)` (create-personas.ts) writes them to a database. */
export interface Persona {
  key: 'omar' | 'nadia' | 'rafi' | 'sameera' | 'tariq' | 'priya' | 'lena';
  name: string;
  email: string;
  /**
   * Further verified addresses (seed v2, `createPersonas(db, { verifiedEmails: true })`): the address a person has at an
   * identity provider that does not use the `kahf.example` test domain, e.g. Tariq's Google Workspace login at kahf.co.
   */
  aliases: string[];
  personId: PersonId;
  /** The `actors` row id that goes into `withActor`. */
  actorId: ActorId;
  workspaceId: WorkspaceId;
  /** Workspace roles; Omar is both `owner` and `admin`. */
  workspaceRoles: WorkspaceRole[];
  teams: PersonaTeamMembership[];
  /** Channels a guest was added to (Lena only). */
  guestChannels: string[];
}

/** Workspace "Kahf Software" (seed workspace, fixed uuid so screenshots and fixtures are stable). */
export const KAHF_WORKSPACE_ID = '00000000-0000-7000-8000-00000000a001' as WorkspaceId;

/** Fixed team ids of the seed workspace. */
export const TEAM_IDS: Record<TeamName, TeamId> = {
  Engineering: '00000000-0000-7000-8000-0000000b0001' as TeamId,
  'Customer support': '00000000-0000-7000-8000-0000000b0002' as TeamId,
  Marketing: '00000000-0000-7000-8000-0000000b0003' as TeamId,
};

const make = (
  n: number,
  p: Omit<Persona, 'personId' | 'actorId' | 'workspaceId' | 'email' | 'guestChannels' | 'aliases'> & { guestChannels?: string[]; aliases?: string[] },
): Persona => ({
  ...p,
  email: `${p.key}@kahf.example`,
  aliases: p.aliases ?? [],
  personId: `00000000-0000-7000-8000-0000000c000${n}` as PersonId,
  actorId: `00000000-0000-7000-8000-0000000d000${n}` as ActorId,
  workspaceId: KAHF_WORKSPACE_ID,
  guestChannels: p.guestChannels ?? [],
});

export const OMAR = make(1, {
  key: 'omar',
  name: 'Omar',
  workspaceRoles: ['owner', 'admin'],
  teams: [{ team: 'Engineering', role: 'lead', tags: [] }],
});
export const NADIA = make(2, {
  key: 'nadia',
  name: 'Nadia',
  workspaceRoles: ['member'],
  teams: [{ team: 'Engineering', role: 'member', tags: ['role:release-owner'] }],
});
export const RAFI = make(3, {
  key: 'rafi',
  name: 'Rafi',
  workspaceRoles: ['member'],
  teams: [{ team: 'Engineering', role: 'member', tags: ['role:on-call'] }],
});
export const SAMEERA = make(4, {
  key: 'sameera',
  name: 'Sameera',
  workspaceRoles: ['member'],
  teams: [{ team: 'Customer support', role: 'member', tags: ['role:support-agent'] }],
});
export const TARIQ = make(5, {
  key: 'tariq',
  name: 'Tariq',
  aliases: ['tariq@kahf.co'],
  workspaceRoles: ['member'],
  teams: [{ team: 'Marketing', role: 'lead', tags: [] }],
});
export const PRIYA = make(6, {
  key: 'priya',
  name: 'Priya',
  workspaceRoles: ['member'],
  teams: [
    { team: 'Engineering', role: 'member', tags: [] },
    { team: 'Marketing', role: 'member', tags: [] },
  ],
});
export const LENA = make(7, {
  key: 'lena',
  name: 'Lena',
  workspaceRoles: ['guest'],
  teams: [],
  guestChannels: ['#releases'],
});

export const personas = { omar: OMAR, nadia: NADIA, rafi: RAFI, sameera: SAMEERA, tariq: TARIQ, priya: PRIYA, lena: LENA } as const;
export const allPersonas: readonly Persona[] = Object.values(personas);

/** The persona as the `Actor` that `withActor` takes. */
export function personaActor(persona: Persona): Actor {
  return { kind: 'person', id: persona.actorId, workspaceId: persona.workspaceId };
}
