import { InstallRecipeResponse, ListRecipesResponse, type RecipeCard } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// P18-01 (server): the recipe gallery on a real server. What it proves: the list shows every recipe on disk with what it needs and where it stands; installing files one proposal per
// file as the person who pressed the button (nothing is committed); a second press, a bot that is already there, a guest and someone outside the team are each refused in words; a
// workspace admin approves the bot and the card turns to installed; a team lead who is not an admin can propose but cannot apply the bot.

const { omar, nadia, tariq, lena } = personas;
vi.setConfig({ testTimeout: 120_000 });

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

type Who = typeof omar;
type Err = { error?: { message: string } };
const list = (who: Who | null, team: string) => w.call<ListRecipesResponse & Err>(who, 'GET', `/api/teams/${team}/recipes`);
const install = (who: Who | null, team: string, id: string) => w.call<InstallRecipeResponse & Err>(who, 'POST', `/api/teams/${team}/recipes/${id}/install`, {});
const card = async (who: Who, team: string, id: string): Promise<RecipeCard> => {
  const res = await list(who, team);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListRecipesResponse.parse(res.body).recipes.find((r) => r.id === id)!;
};
const decide = (who: Who, team: string, proposalId: string, verb: 'approve' | 'reject') => w.call<Err>(who, 'POST', `/api/teams/${team}/proposals/${proposalId}/${verb}`, {});
const openIn = async (team: string): Promise<number> =>
  w.system(async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.proposals p JOIN app.teams t ON t.id = p.team_id WHERE t.slug = $1 AND p.status = 'open'", [team])).rows[0]!.n));

describe('the gallery list', () => {
  it('is for signed-in people of the team, and shows each recipe with its schedule, abilities, evals and state', async () => {
    expect((await list(null, 'engineering')).status).toBe(401);
    expect([403, 404]).toContain((await list(tariq, 'engineering')).status);
    const res = await list(nadia, 'engineering');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = ListRecipesResponse.parse(res.body);
    expect(body.recipes.length).toBeGreaterThanOrEqual(18);
    expect(body.canInstall).toBe(true);
    expect(body.recipes.every((r) => r.state === 'available' && r.openProposals === 0 && !r.scheduled)).toBe(true);
    const intake = body.recipes.find((r) => r.id === 'request-intake')!;
    expect(intake.bot).toMatchObject({ slug: 'request-intake', runtime: 'hermes' });
    expect(intake.paths).toEqual(['bots/request-intake/BOT.md', 'bots/request-intake/evals/request-intake.yaml', 'routines/request-intake.yaml']);
    expect(intake.abilities.length).toBeGreaterThan(0);
    expect(intake.abilities.join(' ')).not.toMatch(/\./); // plain words, never a tool id such as messages.post
    expect(intake.evals.cases).toBeGreaterThanOrEqual(2);
    expect(intake.outputPage).toMatch(/^pages\/recipes\//);
  });

  it('tells a guest there is nothing to install for them', async () => {
    const res = await list(lena, 'engineering');
    if (res.status === 200) expect(res.body.canInstall).toBe(false);
    else expect([403, 404]).toContain(res.status);
  });
});

describe('installing files proposals and commits nothing', () => {
  let ids: string[] = [];

  it('files one proposal per file as the person, and the card turns to waiting', async () => {
    const before = await openIn('engineering');
    const res = await install(nadia, 'engineering', 'request-intake');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const done = InstallRecipeResponse.parse(res.body);
    expect(done.proposals.map((p) => p.path)).toEqual(done.recipe.paths);
    expect(done.proposals.every((p) => p.checksOk)).toBe(true);
    ids = done.proposals.map((p) => p.id);
    expect(done.recipe.state).toBe('waiting');
    expect(done.recipe.openProposals).toBe(3);
    expect(await openIn('engineering')).toBe(before + 3);
    // nothing reached the repository
    expect((await w.call(omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent('bots/request-intake/BOT.md')}`)).status).toBe(404);
    expect((await card(omar, 'engineering', 'request-intake')).state).toBe('waiting');
  });

  it('refuses a second press while the first is still waiting, naming where to look', async () => {
    const res = await install(omar, 'engineering', 'request-intake');
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toMatch(/already waiting for approval/);
    expect(await openIn('engineering')).toBeGreaterThanOrEqual(3);
  });

  it('refuses an unknown recipe, a guest and a person outside the team', async () => {
    expect((await install(nadia, 'engineering', 'no-such-recipe')).status).toBe(404);
    expect((await install(null, 'engineering', 'daily-standup')).status).toBe(401);
    expect([403, 404]).toContain((await install(lena, 'engineering', 'daily-standup')).status);
    expect([403, 404]).toContain((await install(tariq, 'engineering', 'daily-standup')).status);
    expect((await card(omar, 'engineering', 'daily-standup')).state).toBe('available');
  });

  it('a member who is not an admin cannot apply the bot; a workspace admin can, and the card turns to installed', async () => {
    const botProposal = ids[0]!;
    const refused = await decide(nadia, 'engineering', botProposal, 'approve');
    expect(refused.status).toBe(403);
    const ok = await decide(omar, 'engineering', botProposal, 'approve');
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    await vi.waitFor(async () => expect((await card(omar, 'engineering', 'request-intake')).state).toBe('installed'), { timeout: 30_000, interval: 250 });
    // the other two files are still the lead's to apply; the card stays installed and counts them
    expect((await card(omar, 'engineering', 'request-intake')).openProposals).toBe(2);
    const again = await install(omar, 'engineering', 'request-intake');
    expect(again.status).toBe(409);
    expect(again.body.error?.message).toMatch(/already has a bot called request-intake/);
  });

  it('after the other files are applied the schedule can be turned on, and the card says so', async () => {
    for (const id of ids.slice(1)) {
      const res = await decide(omar, 'engineering', id, 'approve');
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    }
    const c = await card(omar, 'engineering', 'request-intake');
    expect(c.openProposals).toBe(0);
    expect(c.scheduled).toBe(false);
    const made = await w.call(omar, 'POST', '/api/teams/engineering/scheduled-jobs', { name: c.name, kind: 'routine', schedule: c.schedule.cron, contractPath: 'routines/request-intake.yaml', botSlug: c.bot.slug });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    expect((await card(omar, 'engineering', 'request-intake')).scheduled).toBe(true);
  });
});

describe('a team lead who is not a workspace admin', () => {
  it('may propose a recipe but may not apply its bot', async () => {
    const res = await install(tariq, 'marketing', 'content-calendar');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const done = InstallRecipeResponse.parse(res.body);
    const bot = done.proposals.find((p) => p.path.endsWith('/BOT.md'))!;
    expect((await decide(tariq, 'marketing', bot.id, 'approve')).status).toBe(403);
    expect((await card(tariq, 'marketing', 'content-calendar')).state).toBe('waiting');
    // withdrawn by the one who made it, the recipe is available again
    for (const p of done.proposals) expect((await w.call(tariq, 'POST', `/api/teams/marketing/proposals/${p.id}/withdraw`, {})).status).toBeLessThan(300);
    expect((await card(tariq, 'marketing', 'content-calendar')).state).toBe('available');
  });
});
