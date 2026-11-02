import { readFileSync } from 'node:fs';
import { BOT_ANIMAL_AVATAR_PRESETS, BOT_AVATAR_PRESETS, BRAIN_DEFAULT_AVATAR, BotAvatarPresetId } from '@manythreads/shared';
import { seedRepo, testClient } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';
import { newBotAvatar, setBotAvatarRandom } from '../src/avatar.ts';

// The picture a bot is given when its row is first created (PLAN P14-24): a random animal, Brain's chip for Brain, never re-rolled, and the migration's
// backfill. The unit half needs no database; the rest drives the real loader and the real migration.

const { omar } = personas;
vi.setConfig({ testTimeout: 60_000 });

const POOL = BOT_ANIMAL_AVATAR_PRESETS.map((p) => `preset:${p.id}`);

describe('the pool a new bot draws from', () => {
  it('holds all 19 animals and never a Brain picture', () => {
    expect(POOL).toHaveLength(19);
    const seen = new Set<string>();
    for (let i = 0; i < POOL.length; i++) seen.add(newBotAvatar('some-bot', () => (i + 0.5) / POOL.length));
    expect([...seen].sort()).toEqual([...POOL].sort());
    for (const id of seen) expect(id).not.toMatch(/brain/);
    expect(BOT_AVATAR_PRESETS.filter((p) => p.group === 'brain')).toHaveLength(6);
  });

  it('is exact for an injected source, and safe for a source outside [0, 1)', () => {
    expect(newBotAvatar('x', () => 0)).toBe(POOL[0]);
    expect(newBotAvatar('x', () => 0.999_999)).toBe(POOL[18]);
    expect(newBotAvatar('x', () => 1)).toBe(POOL[18]);
    expect(newBotAvatar('x', () => -3)).toBe(POOL[0]);
    expect(newBotAvatar('x', () => Number.NaN)).toBe(POOL[0]);
  });

  it('gives Brain the chip, whatever the dice say', () => {
    expect(newBotAvatar('brain', () => 0.7)).toBe('preset:bot-brain-chip');
    expect(newBotAvatar('brain', () => 0.7)).toBe(BRAIN_DEFAULT_AVATAR);
  });

  it('every id it can give is a valid bot picture', () => {
    for (const p of POOL) expect(BotAvatarPresetId.safeParse(p.slice(7)).success, p).toBe(true);
  });

  it('the migration\'s list of animals is the shared list, in the same order', () => {
    const sql = readFileSync(new URL('../migrations/0021_bot_avatar_library.sql', import.meta.url), 'utf8');
    const listed = [...sql.slice(sql.indexOf('ARRAY['), sql.indexOf('])[1')).matchAll(/'(bot-noto-[a-z0-9-]+)'/g)].map((m) => `preset:${m[1]!}`);
    expect(listed).toEqual(POOL);
  });
});

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
  await seedRepo(w.server.db, { attachments: false });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ENG = TEAM_IDS.Engineering;
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the loader');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const avatarOf = (slug: string): Promise<string | null | undefined> =>
  w.system(async (tx) => (await tx.query<{ avatar: string | null }>('SELECT avatar FROM app.bots WHERE team_id = $1 AND slug = $2', [ENG, slug])).rows[0]?.avatar);
const exists = (slug: string): Promise<boolean | undefined> =>
  w.system(async (tx) => ((await tx.query('SELECT 1 FROM app.bots WHERE team_id = $1 AND slug = $2', [ENG, slug])).rows.length > 0 ? true : undefined));
const md = (name: string, extra = ''): string => `---
schema: 1
name: ${name}
role: Gets a picture in the loader tests${extra}
kind: agent
runtime: hermes
triggers:
  - type: mention
capabilities:
  native: [messages.post]
---

# ${name}
`;
const commit = (path: string, content: string) => w.commitRaw(omar, 'engineering', [{ op: 'put', path, content }], `Write ${path}`);

describe('a bot loaded from BOT.md', () => {
  it('is given a random animal when its row is first created, never re-rolled by an edit, and a chosen picture stays', async () => {
    const restore = setBotAvatarRandom(() => 0.5);
    try {
      expect((await commit('bots/pic-one/BOT.md', md('Pic one'))).status).toBe(201);
      await until(() => exists('pic-one'));
      expect(await avatarOf('pic-one')).toBe(POOL[9]); // floor(0.5 * 19)
    } finally {
      restore();
    }
    // the next dice would give another animal; an edit and a reload must not ask them
    const restoreTwo = setBotAvatarRandom(() => 0);
    try {
      expect((await commit('bots/pic-one/BOT.md', md('Pic one, renamed'))).status).toBe(201);
      await until(async () => (await w.system(async (tx) => (await tx.query<{ name: string }>("SELECT name FROM app.bots WHERE team_id = $1 AND slug = 'pic-one'", [ENG])).rows[0]?.name)) === 'Pic one, renamed');
      expect(await avatarOf('pic-one')).toBe(POOL[9]);

      // a person's choice, then another reload: the choice stays
      await w.system((tx) => tx.query("UPDATE app.bots SET avatar = 'preset:bot-brain-neural' WHERE team_id = $1 AND slug = 'pic-one'", [ENG]));
      expect((await commit('bots/pic-one/BOT.md', md('Pic one, again'))).status).toBe(201);
      await until(async () => (await w.system(async (tx) => (await tx.query<{ name: string }>("SELECT name FROM app.bots WHERE team_id = $1 AND slug = 'pic-one'", [ENG])).rows[0]?.name)) === 'Pic one, again');
      expect(await avatarOf('pic-one')).toBe('preset:bot-brain-neural');

      // "use initials" is a choice too: it is not given a picture again
      await w.system((tx) => tx.query("UPDATE app.bots SET avatar = NULL WHERE team_id = $1 AND slug = 'pic-one'", [ENG]));
      expect((await commit('bots/pic-one/BOT.md', md('Pic one, third'))).status).toBe(201);
      await until(async () => (await w.system(async (tx) => (await tx.query<{ name: string }>("SELECT name FROM app.bots WHERE team_id = $1 AND slug = 'pic-one'", [ENG])).rows[0]?.name)) === 'Pic one, third');
      expect(await avatarOf('pic-one')).toBeNull();
    } finally {
      restoreTwo();
    }
  });

  it('Brain is given the chip, not a random animal', async () => {
    const restore = setBotAvatarRandom(() => 0.9);
    try {
      expect((await commit('bots/brain/BOT.md', md('Brain'))).status).toBe(201);
      await until(() => exists('brain'));
      expect(await avatarOf('brain')).toBe('preset:bot-brain-chip');
    } finally {
      restore();
    }
  });

  it('with the real dice every new bot still has a valid bot picture of the animals', async () => {
    expect((await commit('bots/pic-real/BOT.md', md('Pic real'))).status).toBe(201);
    await until(() => exists('pic-real'));
    const avatar = await avatarOf('pic-real');
    expect(POOL).toContain(avatar);
  });
});

describe('the migration backfill', () => {
  const insert = (slug: string, avatar: string | null): Promise<string> =>
    w.system(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, avatar)
           VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active', $4) RETURNING id`,
          [omar.workspaceId, ENG, slug, avatar],
        )
      ).rows[0]!.id,
    );
  const block = (): string => {
    const file = readFileSync(new URL('../migrations/0021_bot_avatar_library.sql', import.meta.url), 'utf8');
    return file.slice(file.indexOf('-- legacy-begin') + '-- legacy-begin'.length, file.indexOf('-- legacy-end'));
  };

  it('gives a bot with no picture one from a hash of its id, Brain the chip, touches none that has a value, and gives the same answer again', async () => {
    const plain = await insert('bf-plain', null);
    await insert('brain-bf', null);
    // slug is what makes Brain: use the real slug in another team so the (team, slug) pair is free
    const brainReal = await w.system(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
           VALUES ($1, $2, 'brain', 'Brain', '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
          [omar.workspaceId, TEAM_IDS.Marketing],
        )
      ).rows[0]!.id,
    );
    await insert('bf-chosen', 'preset:bot-noto-sloth');
    await insert('bf-legacy', 'preset:bot-kitty-1');
    expect(block()).toContain('SET ROLE manythreads_system');

    const run = async (): Promise<Record<string, string | null>> => {
      const admin = testClient({ connectionString: w.server.db.ownerUrl });
      await admin.connect();
      try {
        await admin.query(block());
      } finally {
        await admin.end();
      }
      const rows = await w.system(async (tx) =>
        (await tx.query<{ slug: string; avatar: string | null }>("SELECT slug, avatar FROM app.bots WHERE slug IN ('bf-plain', 'brain-bf', 'bf-chosen', 'bf-legacy') OR id = $1", [brainReal])).rows,
      );
      return Object.fromEntries(rows.map((r) => [r.slug, r.avatar]));
    };
    const first = await run();
    expect(POOL).toContain(first['bf-plain']);
    expect(POOL).toContain(first['brain-bf']); // the slug is not `brain`: an ordinary bot
    expect(first['brain']).toBe('preset:bot-brain-chip');
    expect(first['bf-chosen']).toBe('preset:bot-noto-sloth');
    expect(first['bf-legacy']).toBe('preset:bot-kitty-1');
    // repeatable: the same answer the second time, because it comes from the id
    expect(await run()).toEqual(first);
    // and it is the hash of the id: the function gives the same picture on its own
    const direct = await w.system(async (tx) => (await tx.query<{ a: string }>('SELECT app.bot_default_avatar($1::uuid, $2) AS a', [plain, 'bf-plain'])).rows[0]!.a);
    expect(direct).toBe(first['bf-plain']);
  });

  it('spreads over the whole list: every animal is reachable from some id', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`);
    const given = await w.system(async (tx) =>
      (await tx.query<{ a: string }>('SELECT app.bot_default_avatar(i::uuid, $2) AS a FROM unnest($1::text[]) AS i', [ids, 'x'])).rows.map((r) => r.a),
    );
    expect(new Set(given)).toEqual(new Set(POOL));
  });
});
