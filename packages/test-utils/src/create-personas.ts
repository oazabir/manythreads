import { randomBytes } from 'node:crypto';
import { createSystemPool, hashPassword, withSystem } from '@manythreads/kernel';
import type { RoleId } from '@manythreads/shared';
import type { TestDatabase } from './db.ts';
import {
  allPersonas,
  KAHF_WORKSPACE_ID,
  TEAM_IDS,
  type Persona,
  type TeamName,
  type WorkspaceRole,
} from './personas.ts';

/** Every persona's password (12+ characters, SPEC §4). */
export const PERSONA_PASSWORD = 'correct-horse-battery';

export const KAHF_WORKSPACE = { id: KAHF_WORKSPACE_ID, slug: 'kahf-software', name: 'Kahf Software' } as const;

const TEAM_SLUGS: Record<TeamName, string> = {
  Engineering: 'engineering',
  'Customer support': 'customer-support',
  Marketing: 'marketing',
};

/** Fixed role-tag ids, so fixtures and screenshots are stable. */
export const ROLE_IDS = {
  'role:release-owner': '00000000-0000-7000-8000-0000000e0001' as RoleId,
  'role:on-call': '00000000-0000-7000-8000-0000000e0002' as RoleId,
  'role:support-agent': '00000000-0000-7000-8000-0000000e0003' as RoleId,
} as const;

export interface CreatePersonasOptions {
  /** `fixed` (default): everybody has `PERSONA_PASSWORD`. `random`: unknown, unrecoverable passwords (demo deployments). */
  passwords?: 'fixed' | 'random';
  /**
   * Also write a verified `person_emails` row for the primary address and every alias, so OIDC sign-in can link an
   * identity to the person (the linker only trusts verified addresses). Default false.
   */
  verifiedEmails?: boolean;
}

export interface CreatedPersonas {
  workspaceId: typeof KAHF_WORKSPACE_ID;
  teams: typeof TEAM_IDS;
  roles: typeof ROLE_IDS;
  personas: readonly Persona[];
  /** The shared password, or null when the passwords are random (nobody knows them). */
  password: string | null;
}

const workspaceRoleOf = (roles: readonly WorkspaceRole[]): WorkspaceRole =>
  roles.includes('owner') ? 'owner' : roles.includes('admin') ? 'admin' : (roles[0] ?? 'member');

/**
 * Creates the seed world of PLAN.md section 4 in ONE call, as the system actor: workspace Kahf Software, teams
 * Engineering, Customer support and Marketing, the seven personas (people, actors, workspace roles, team memberships,
 * role tags) and an argon2id password credential for each (`PERSONA_PASSWORD`). Ids are fixed (see personas.ts).
 * Idempotent: a second call changes nothing. `db` is any object with a `systemUrl` (a TestDatabase).
 */
export async function createPersonas(
  db: Pick<TestDatabase, 'systemUrl'>,
  options: CreatePersonasOptions = {},
): Promise<CreatedPersonas> {
  const random = options.passwords === 'random';
  // 'random': a fresh 192-bit secret per person that is hashed and then dropped; nothing prints or keeps it, so a
  // public deployment has no known password. Existing credentials are never replaced (ON CONFLICT DO NOTHING).
  const hashes = await Promise.all(
    allPersonas.map(() => hashPassword(random ? randomBytes(24).toString('base64url') : PERSONA_PASSWORD)),
  );
  const pool = createSystemPool(db.systemUrl, 2);
  try {
    await withSystem(
      async (tx) => {
        const ws = KAHF_WORKSPACE_ID;
        await tx.query(
          `INSERT INTO app.workspaces (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [ws, KAHF_WORKSPACE.slug, KAHF_WORKSPACE.name],
        );
        for (const [name, id] of Object.entries(TEAM_IDS) as [TeamName, string][]) {
          await tx.query(
            `INSERT INTO app.teams (id, workspace_id, slug, name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [id, ws, TEAM_SLUGS[name], name],
          );
        }
        for (const [name, id] of Object.entries(ROLE_IDS)) {
          await tx.query(`INSERT INTO app.roles (id, workspace_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
            id,
            ws,
            name,
          ]);
        }
        for (const [i, p] of allPersonas.entries()) {
          await tx.query(
            `INSERT INTO app.people (id, workspace_id, display_name, primary_email) VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [p.personId, ws, p.name, p.email],
          );
          if (options.verifiedEmails) {
            for (const email of [p.email, ...p.aliases]) {
              await tx.query(
                `INSERT INTO app.person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, $3, now())
                 ON CONFLICT DO NOTHING`,
                [ws, p.personId, email],
              );
            }
          }
          await tx.query(
            `INSERT INTO app.actors (id, kind, workspace_id, ref_id) VALUES ($1, 'person', $2, $3) ON CONFLICT DO NOTHING`,
            [p.actorId, ws, p.personId],
          );
          await tx.query(
            `INSERT INTO app.workspace_members (workspace_id, person_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [ws, p.personId, workspaceRoleOf(p.workspaceRoles)],
          );
          await tx.query(
            `INSERT INTO app.password_credentials (person_id, hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [p.personId, hashes[i]],
          );
          for (const m of p.teams) {
            await tx.query(
              `INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING`,
              [TEAM_IDS[m.team], p.actorId, ws, m.role],
            );
            for (const tag of m.tags) {
              const roleId = ROLE_IDS[tag as keyof typeof ROLE_IDS];
              if (!roleId) throw new Error(`createPersonas: no fixed role id for tag ${tag}`);
              await tx.query(
                `INSERT INTO app.role_members (role_id, person_id, workspace_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                [roleId, p.personId, ws],
              );
            }
          }
        }
      },
      { pool, workspaceId: KAHF_WORKSPACE_ID },
    );
  } finally {
    await pool.end();
  }
  return { workspaceId: KAHF_WORKSPACE_ID, teams: TEAM_IDS, roles: ROLE_IDS, personas: allPersonas, password: random ? null : PERSONA_PASSWORD };
}
