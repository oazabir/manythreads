import { ownerSql, seedRepo } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GetBotResponse, ListBotsResponse, BotSummary } from '@manythreads/shared';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// The roster and bot-page reads (PLAN P5-05, SPEC §7.5): `GET /api/teams/:slug/bots` and `GET /api/teams/:slug/bots/:botSlug`. Both are
// reads over rows the loader wrote, and the `invalid` reason comes from the newest `bots.bot.invalid` event rather than a column. The
// loader runs in the outbox consumer, so every assertion that follows a commit waits for it.

const { omar, nadia, rafi, sameera, lena } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
  await seedRepo(w.server.db, { attachments: false });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the loader');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const engSlug = 'engineering';
const listRoster = (who: typeof omar) => w.call<ListBotsResponse>(who, 'GET', `/api/teams/${engSlug}/bots`);
const getBot = (who: typeof omar, slug: string) => w.call<GetBotResponse>(who, 'GET', `/api/teams/${engSlug}/bots/${slug}`);
const summaryOf = (body: ListBotsResponse, slug: string): BotSummary | undefined => body.bots.find((b) => b.slug === slug);

const validMd = (name: string, role: string, mayTag: readonly string[]): string => `---
schema: 1
name: ${name}
role: ${role}
kind: agent
runtime: hermes
triggers:
  - type: mention
capabilities:
  native: [messages.post]
handover:
  mayTag: [${mayTag.join(', ')}]
---

# ${name}

Soul text.
`;

describe('the bot roster and bot page', () => {
  it('a member reads the roster: the loader-copied display fields, sorted by name, with no invalid reason', async () => {
    const content = validMd('Zed', 'Answers the roster tests', ['reviewer']);
    expect((await w.commit(omar, engSlug, [{ op: 'put', path: 'bots/p505-zed/BOT.md', content }], 'Add Zed')).status).toBe(201);
    await until(async () => summaryOf((await listRoster(nadia)).body, 'p505-zed'), 10_000);

    const res = await listRoster(nadia);
    expect(res.status).toBe(200);
    const zed = summaryOf(res.body, 'p505-zed')!;
    // Zed lists a mention trigger only, so nobody can talk to it (the router answers a conversation for the conversation trigger alone)
    expect(zed).toMatchObject({ slug: 'p505-zed', name: 'Zed', role: 'Answers the roster tests', mayTag: ['reviewer'], status: 'active', invalid: null, conversational: false });
    // a card names its holder by actor id, so the roster carries the bot's actor id (not the bots row id), for a member who cannot read the actor row
    const actor = await ownerSql(w.server.db.ownerUrl, `SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [zed.id]);
    expect(zed.actorId).toBe(actor[0]?.['id']);
    expect(zed.actorId).not.toBe(zed.id);
    expect((await getBot(nadia, 'p505-zed')).body.bot.actorId).toBe(zed.actorId);
    // the list is ordered by the display name
    const names = res.body.bots.map((b) => b.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(res.body.bots.length).toBeGreaterThan(1);
  });

  it('`conversational` follows the definition: true once it lists a conversation trigger, false again when it is dropped', async () => {
    const withConversation = validMd('Chatty', 'Talks', []).replace('  - type: mention\n', '  - type: mention\n  - type: conversation\n');
    expect(withConversation).toContain('type: conversation');
    expect((await w.commit(omar, engSlug, [{ op: 'put', path: 'bots/p516-chatty/BOT.md', content: withConversation }], 'Add Chatty')).status).toBe(201);
    await until(async () => summaryOf((await listRoster(nadia)).body, 'p516-chatty'), 10_000);
    expect(summaryOf((await listRoster(nadia)).body, 'p516-chatty')).toMatchObject({ conversational: true });
    expect((await getBot(nadia, 'p516-chatty')).body.bot.conversational).toBe(true);

    const without = validMd('Chatty', 'Talks', []);
    expect((await w.commit(omar, engSlug, [{ op: 'put', path: 'bots/p516-chatty/BOT.md', content: without }], 'Chatty stops taking conversations')).status).toBe(201);
    await until(async () => ((await getBot(nadia, 'p516-chatty')).body.bot.conversational === false ? true : null), 10_000);
  });

  it('the run list holds the runs of the team, and a conversation run only for the person who asked', async () => {
    const bot = (await getBot(nadia, 'p516-chatty')).body.bot;
    // two runs made as the system (what the run service does): a mention, and a conversation Nadia had with the bot
    await w.system(async (tx) => {
      await tx.query(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, ended_at) VALUES
           ($1, $2, $3, 'mention', $4, 'done', now()),
           ($1, $2, $3, 'conversation', $4, 'done', now())`,
        [omar.workspaceId, bot.id, bot.teamId, nadia.actorId],
      );
    });
    const triggersFor = async (who: typeof omar): Promise<string[]> => (await getBot(who, 'p516-chatty')).body.runs.map((r) => r.trigger).sort();
    expect(await triggersFor(nadia)).toEqual(['conversation', 'mention']);
    // a teammate, and the team's lead who is also a workspace admin, read the mention run and nothing of the conversation
    expect(await triggersFor(rafi)).toEqual(['mention']);
    expect(await triggersFor(omar)).toEqual(['mention']);
  });

  it('the bot page answers the definition path and the (empty) run list', async () => {
    const res = await getBot(nadia, 'p505-zed');
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('bots/p505-zed/BOT.md');
    expect(res.body.bot).toMatchObject({ slug: 'p505-zed', name: 'Zed' });
    expect(res.body.runs).toEqual([]);
  });

  it('an unknown bot slug is 404 in the product words; a bot of another team answers the same', async () => {
    const res = await getBot(omar, 'no-such-bot');
    expect(res.status).toBe(404);
    expect(res.body as unknown as { error: { code: string } }).toMatchObject({ error: { code: 'not_found' } });
  });

  it('a broken definition surfaces its field path and message on the page, while the row keeps its last-good definition sha', async () => {
    const goodSha = (await getBot(omar, 'p505-zed')).body.bot.definitionSha;
    const broken = validMd('Zed', 'Answers the roster tests', []).replace('capabilities:', 'capabilties:');
    expect((await w.commit(omar, engSlug, [{ op: 'put', path: 'bots/p505-zed/BOT.md', content: broken }], 'Break Zed')).status).toBe(201);

    const bot = await until(async () => {
      const b = (await getBot(omar, 'p505-zed')).body.bot;
      return b.invalid ? b : null;
    }, 10_000);
    expect(bot.status).toBe('invalid');
    expect(bot.definitionSha).toBe(goodSha); // the row keeps the last good definition
    expect(bot.invalid).toMatchObject({ fieldPath: 'capabilties', definitionSha: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(bot.invalid!.message.length).toBeGreaterThan(0);
    expect(bot.invalid!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // the roster carries the same reason
    const zed = summaryOf((await listRoster(nadia)).body, 'p505-zed')!;
    expect(zed.invalid).toMatchObject({ fieldPath: 'capabilties' });
  });

  it('a repaired definition drops the red banner: the reason follows the last load, not the newest alert', async () => {
    const fixed = validMd('Zed', 'Answers the roster tests, repaired', []);
    expect((await w.commit(omar, engSlug, [{ op: 'put', path: 'bots/p505-zed/BOT.md', content: fixed }], 'Fix Zed')).status).toBe(201);

    const bot = await until(async () => {
      const b = (await getBot(omar, 'p505-zed')).body.bot;
      return b.status === 'active' ? b : null;
    }, 10_000);
    expect(bot.invalid).toBeNull();
    expect(summaryOf((await listRoster(nadia)).body, 'p505-zed')).toMatchObject({ status: 'active', invalid: null, role: 'Answers the roster tests, repaired' });
  });

  it('a person who cannot see the team is refused: another team 403, a guest 403', async () => {
    expect((await listRoster(sameera)).status).toBe(403);
    expect((await listRoster(lena)).status).toBe(403);
    expect((await getBot(sameera, 'p505-zed')).status).toBe(403);
  });
});
