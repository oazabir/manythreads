import { verifyPassword } from '@manythreads/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  dropTestDatabase,
  KAHF_WORKSPACE_ID,
  ownerSql,
  PERSONA_PASSWORD,
  seedWorld,
  TARIQ,
  type TestDatabase,
} from '../src/index.ts';

let db: TestDatabase;

const rows = <T extends Record<string, unknown>>(sql: string, url: string = db.ownerUrl): Promise<T[]> => ownerSql<T>(url, sql);
const hashOf = async (url: string = db.ownerUrl): Promise<string> =>
  (await rows<{ hash: string }>(`SELECT hash FROM app.password_credentials WHERE person_id = '${TARIQ.personId}'`, url))[0]?.hash ?? '';

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  if (db) await dropTestDatabase(db);
});

describe('seedWorld (seed v2)', () => {
  it('builds Kahf Software with teams, personas, templates and verified addresses, and a second run changes nothing', async () => {
    const first = await seedWorld(db);
    expect(first).toMatchObject({ created: true, skipped: null, passwordMode: 'fixed', workspaceId: KAHF_WORKSPACE_ID });

    const before = await rows(`SELECT (SELECT count(*) FROM app.people)::int people, (SELECT count(*) FROM app.person_emails)::int emails,
      (SELECT count(*) FROM app.teams)::int teams, (SELECT count(*) FROM app.team_members)::int seats`);
    expect(before[0]).toEqual({ people: 7, emails: 8, teams: 3, seats: 7 });

    const emails = await rows<{ email: string; verified: boolean }>(
      'SELECT email, verified_at IS NOT NULL AS verified FROM app.person_emails WHERE person_id = $$' + TARIQ.personId + '$$ ORDER BY email',
    );
    expect(emails).toEqual([
      { email: 'tariq@kahf.co', verified: true },
      { email: 'tariq@kahf.example', verified: true },
    ]);
    const teams = await rows<{ slug: string; template: string | null; def: string | null }>(
      "SELECT slug, template, template_definition ->> 'id' AS def FROM app.teams ORDER BY slug",
    );
    expect(teams).toEqual([
      { slug: 'customer-support', template: 'customer-support', def: 'customer-support' },
      { slug: 'engineering', template: 'engineering', def: 'engineering' },
      { slug: 'marketing', template: 'marketing', def: 'marketing' },
    ]);

    const second = await seedWorld(db);
    expect(second.created).toBe(false);
    expect((await rows(`SELECT (SELECT count(*) FROM app.people)::int people, (SELECT count(*) FROM app.person_emails)::int emails,
      (SELECT count(*) FROM app.teams)::int teams, (SELECT count(*) FROM app.team_members)::int seats`))[0]).toEqual(before[0]);
  });

  it('keeps existing passwords; demo seeding of a fresh database makes unknown ones', async () => {
    const hash = await hashOf();
    expect(await verifyPassword(hash, PERSONA_PASSWORD)).toBe(true);
    await seedWorld(db, { demo: true }); // already seeded: must not rotate anything
    expect(await hashOf()).toBe(hash);

    const demo = await createTestDatabase();
    try {
      const result = await seedWorld(demo, { demo: true });
      expect(result).toMatchObject({ created: true, passwordMode: 'random' });
      expect(result.personas?.password).toBeNull();
      const hashes = await rows<{ hash: string }>('SELECT hash FROM app.password_credentials', demo.ownerUrl);
      expect(new Set(hashes.map((h) => h.hash)).size).toBe(7);
      for (const h of hashes) {
        expect(h.hash.startsWith('$argon2id$')).toBe(true);
        expect(await verifyPassword(h.hash, PERSONA_PASSWORD)).toBe(false);
      }
    } finally {
      await dropTestDatabase(demo);
    }
  }, 60_000);

  it('leaves a database alone that already has another workspace', async () => {
    const other = await createTestDatabase();
    try {
      await rows("INSERT INTO app.workspaces (slug, name) VALUES ('acme', 'Acme')", other.ownerUrl);
      const result = await seedWorld(other);
      expect(result.skipped).toMatch(/another workspace/);
      expect(await rows('SELECT count(*)::int AS n FROM app.people', other.ownerUrl)).toEqual([{ n: 0 }]);
    } finally {
      await dropTestDatabase(other);
    }
  }, 60_000);
});
