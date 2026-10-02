// Seed v2 for e2e (PLAN.md section 5): workspace "Kahf Software", seven personas, teams Engineering / Customer support /
// Marketing, fixed uuids, verified person_emails (Tariq also has tariq@kahf.co, his Google Workspace login).
// The implementation lives in packages/test-utils (seed.ts) so the same code seeds a deployed database: `pnpm seed [--demo]`.
export {
  allPersonas,
  KAHF_WORKSPACE,
  KAHF_WORKSPACE_ID,
  PERSONA_PASSWORD,
  personas,
  seedWorld,
  TEAM_IDS,
  TEAM_TEMPLATE_IDS,
  type SeedOptions,
  type SeedResult,
} from '@manythreads/test-utils';

/** Every persona's primary address (all share PERSONA_PASSWORD unless the database was seeded with `demo`). */
export const SEED_EMAILS = {
  omar: 'omar@kahf.example',
  nadia: 'nadia@kahf.example',
  rafi: 'rafi@kahf.example',
  sameera: 'sameera@kahf.example',
  tariq: 'tariq@kahf.example',
  priya: 'priya@kahf.example',
  lena: 'lena@kahf.example',
} as const;

/** The address Tariq signs in with at Google Workspace and Microsoft 365 (a verified alias of his person). */
export const TARIQ_WORK_EMAIL = 'tariq@kahf.co';
