import { fileURLToPath } from 'node:url';
import { createSystemPool, loadTemplates, withSystem } from '@manythreads/kernel';
import { createPersonas, KAHF_WORKSPACE, type CreatedPersonas } from './create-personas.ts';
import type { TestDatabase } from './db.ts';
import { KAHF_WORKSPACE_ID, TEAM_IDS, type TeamName } from './personas.ts';

/** Team template each seeded team was created from (folder names under `templates/`). */
export const TEAM_TEMPLATE_IDS: Record<TeamName, string> = {
  Engineering: 'engineering',
  'Customer support': 'customer-support',
  Marketing: 'marketing',
};

export interface SeedOptions {
  /**
   * Public demo deployment: every persona gets a random password that is hashed and forgotten (never printed or stored in
   * clear), so the site has no known credentials. Sign-in is through OIDC, an invitation, the break-glass admin reset or
   * the test-session endpoint. Default false: everybody has `PERSONA_PASSWORD` (tests).
   */
  demo?: boolean;
  /** Where team templates live (default: `MANYTHREADS_TEMPLATES_DIR`, else `templates/` at the repository root). */
  templatesDir?: string;
  /** One line per step; the CLI prints them. */
  log?: (line: string) => void;
}

export interface SeedResult {
  workspaceId: typeof KAHF_WORKSPACE_ID;
  /** True when this call created the workspace, false when it was already there (nothing was changed except gaps filled). */
  created: boolean;
  /** Set when the database holds a different workspace (somebody ran the first-admin bootstrap): nothing was seeded. */
  skipped: string | null;
  personas: CreatedPersonas | null;
  passwordMode: 'fixed' | 'random';
}

/** Where `templates/` is in this checkout (and in the server image, which copies the repository). */
const defaultTemplatesDir = (): string =>
  process.env['MANYTHREADS_TEMPLATES_DIR'] ?? fileURLToPath(new URL('../../../templates/', import.meta.url));

/**
 * Seed v2 (PLAN.md section 5): workspace Kahf Software, the three teams Engineering, Customer support and Marketing (with
 * the template each was created from), the seven personas of section 4 with workspace roles, team seats, role tags and
 * argon2id passwords, and a verified `person_emails` row for each persona's address (Tariq also has `tariq@kahf.co`, his
 * Google Workspace login) so OIDC can link identities. All ids are fixed (personas.ts), so screenshots are stable.
 *
 * Idempotent: a second run inserts nothing new and never replaces an existing password, so a demo site keeps the random
 * passwords of its first seeding. When the database already holds a different workspace the seed does nothing.
 * `db` is any object with the `systemUrl` of a migrated database.
 */
export async function seedWorld(db: Pick<TestDatabase, 'systemUrl'>, options: SeedOptions = {}): Promise<SeedResult> {
  const log = options.log ?? (() => undefined);
  const passwordMode = options.demo ? 'random' : 'fixed';
  const pool = createSystemPool(db.systemUrl, 2);
  let existing: string[];
  try {
    existing = await withSystem(
      async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.workspaces')).rows.map((r) => r.id),
      { pool },
    );
  } finally {
    await pool.end();
  }
  const foreign = existing.filter((id) => id !== KAHF_WORKSPACE_ID);
  if (foreign.length > 0) {
    const reason = 'this database already has another workspace (first-admin bootstrap was used); seed left it alone';
    log(`skipped: ${reason}`);
    return { workspaceId: KAHF_WORKSPACE_ID, created: false, skipped: reason, personas: null, passwordMode };
  }
  const created = existing.length === 0;

  const personas = await createPersonas(db, { passwords: passwordMode, verifiedEmails: true });
  log(`${created ? 'created' : 'found'} workspace ${KAHF_WORKSPACE.name} with ${personas.personas.length} people`);

  const templates = await loadTemplates(options.templatesDir ?? defaultTemplatesDir());
  const pool2 = createSystemPool(db.systemUrl, 2);
  try {
    await withSystem(
      async (tx) => {
        for (const [team, id] of Object.entries(TEAM_IDS) as [TeamName, string][]) {
          const template = templates.find((t) => t.id === TEAM_TEMPLATE_IDS[team]);
          if (!template) throw new Error(`seed: no team template "${TEAM_TEMPLATE_IDS[team]}" in the templates directory`);
          await tx.query(
            `UPDATE app.teams SET template = $2, template_definition = $3::jsonb
              WHERE id = $1 AND template IS NULL`,
            [id, template.id, JSON.stringify(template)],
          );
        }
      },
      { pool: pool2, workspaceId: KAHF_WORKSPACE_ID },
    );
  } finally {
    await pool2.end();
  }
  log(`teams ${Object.keys(TEAM_IDS).join(', ')} carry their template definitions`);
  log(
    passwordMode === 'random'
      ? 'passwords: random for every persona (hashed, not printed, not recoverable)'
      : 'passwords: the shared test password',
  );
  return { workspaceId: KAHF_WORKSPACE_ID, created, skipped: null, personas, passwordMode };
}
