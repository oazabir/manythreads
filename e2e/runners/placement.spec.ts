import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFakeHermesGateway, type FakeHermesGateway } from '../../tools/fake-hermes-gateway/src/server.ts';
import { startFakeLlm, type FakeLlm } from '../../tools/fake-llm/src/server.ts';
import { actorOf } from '../files/support.ts';
import { apiOn, applyGuarded, channelsOf, noSidewaysScroll, openOn, postAs } from '../support/stack-browser.ts';
import { startRunnersWorld, type RunnersWorld } from './support.ts';

/*
 * A team lead, not an admin, places a bot on each kind of runner and gets an answer (PLAN P19-12, the last line of the acceptance). The world is the `runners` stack (seed v19: five runners, a bot on
 * each, made by Omar). Adding a bot is for an admin (a lead changes a bot that already exists), so Omar adds one bot, `lead-bot`; Nadia (in the seed a member, promoted to Engineering lead
 * here) then changes its `placement.runs_on` to each kind of runner in turn, mentions it in #dev, and the reply of that runner's stand-in appears in the channel. What is real: the router, the run, the runner list, the resolver, the data protection on the way out, the runtime and the post of the answer. What is a stand-in: the far end of the
 * runner (a gateway that speaks Hermes' wire; the same wire is the agent bridge's, so one server plays the Claude and Codex pods; a model server for the LLM gateway). A pod needs a cluster, so
 * the pod-based kinds reach their bridge through the test seam of claude-pods (MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL, NODE_ENV=test only). The hermes_pod kind (a team's own pod) has no seam:
 * it is proved on the stage by tools/devbox/stage-runners-probe.sh and the runbook (docs/runbooks/runners-live.md).
 * Screenshots of the channel with each answer go to temp/screenshots/p19-12 (the task gallery).
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);
test.skip(({ isMobile }) => isMobile, 'the runners stack is driven once; the screenshots are taken at both sizes inside the test');

const SHOTS = join(import.meta.dirname, '..', '..', 'temp', 'screenshots', 'p19-12');
const HERMES_KEY = 'e2e-hermes-gateway-key-0001';
const BRIDGE_KEY = 'e2e-bridge-key-0001';

let world: RunnersWorld;
let hermes: FakeHermesGateway;
let bridge: FakeHermesGateway;
let llm: FakeLlm;
let llmCalls = 0;
/** What the bridge stand-in answers: the Claude pod and the Codex pod speak the same wire, so the test says which one is meant. */
let bridgeAnswer = '';

interface Kind {
  label: string;
  runner: string;
  /** The profile the platform asks the far end for. */
  profile: string;
  answer: string;
}
const BOT = 'lead-bot';
const KINDS: Kind[] = [
  { label: 'Hermes gateway', runner: 'office-hermes', profile: BOT, answer: 'STAND-IN-HERMES answered' },
  { label: 'Claude Code', runner: 'claude-shared', profile: `engineering--${BOT}`, answer: 'STAND-IN-CLAUDE answered' },
  { label: 'Codex', runner: 'codex-chatgpt', profile: `engineering--${BOT}`, answer: 'STAND-IN-CODEX answered' },
  { label: 'LLM gateway', runner: 'fast-gateway', profile: '', answer: 'STAND-IN-LLM answered' },
];

const definition = (slug: string, runner: string): string =>
  [
    '---',
    'schema: 1',
    `name: ${slug}`,
    'role: Answers when a lead mentions it, on a runner the lead picked.',
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    '  - type: mention',
    'capabilities:',
    '  native: [messages.post]',
    'placement:',
    `  runs_on: ${runner}`,
    '---',
    '',
    `# ${slug}`,
    '',
    'Placed by a team lead in the runner placement proof.',
    '',
  ].join('\n');

test.beforeAll(async ({ playwright }) => {
  mkdirSync(SHOTS, { recursive: true });
  hermes = await startFakeHermesGateway({
    profiles: {},
    script: (run) => [{ type: 'finish', output: `${KINDS[0]!.answer} on the profile ${run.profile}` }],
  });
  bridge = await startFakeHermesGateway({
    profiles: {},
    script: (run) => [{ type: 'finish', output: `${bridgeAnswer} on the profile ${run.profile}` }],
  });
  llm = await startFakeLlm({
    masterKey: 'sk-fake',
    completion: () => {
      llmCalls += 1;
      return `${KINDS[3]!.answer} through the model gateway`;
    },
  });
  world = await startRunnersWorld({
    NODE_ENV: 'test',
    MANYTHREADS_HERMES_ALLOWED_HOSTS: '127.0.0.1,192.168.50.20', // the stand-ins are on loopback; the seed's own address for the office Hermes must stay allowed so the seed can make it
    MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL: bridge.url,
    MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY: BRIDGE_KEY,
    MANYTHREADS_LITELLM_URL: llm.url,
    MANYTHREADS_LITELLM_MASTER_KEY: 'sk-fake',
  });
  // The admin's part of the set-up: the office Hermes is pointed at the stand-in, and the model gateway gets a provider and the two aliases. Nothing of this is the lead's.
  const omar = await apiOn(playwright, world.stack, 'omar');
  try {
    const headers = await omar.headers();
    const runners = await omar.get<{ items: Array<{ id: string; name: string }> }>('/api/admin/bot-runners');
    const office = runners.items.find((r) => r.name === 'office-hermes');
    expect(office, 'the seeded office Hermes').toBeTruthy();
    const patched = await omar.ctx.patch(`/api/admin/bot-runners/${office!.id}`, { data: { baseUrl: hermes.url, apiKey: HERMES_KEY }, headers });
    expect(patched.status(), await patched.text()).toBeLessThan(300);
    const created = await omar.ctx.post('/api/workspace/llm/providers', { data: { name: 'OpenAI', kind: 'openai', apiKey: ['sk-e2e', 'placement-key-0001'].join('') }, headers });
    expect(created.status(), await created.text()).toBeLessThan(300);
    const providerId = ((await created.json()) as { provider: { id: string } }).provider.id;
    for (const alias of ['smart', 'fast']) {
      const bound = await omar.ctx.put(`/api/workspace/llm/aliases/${alias}`, { data: { providerId, model: 'gpt-4o', fallbacks: [] }, headers });
      expect(bound.status(), await bound.text()).toBe(200);
    }
    await world.stack.sql(`UPDATE app.llm_aliases SET updated_at = updated_at - interval '1 minute'`);
    await world.stack.sql(`UPDATE app.llm_providers SET updated_at = updated_at - interval '1 minute'`);
    // Adding a bot is for an admin: Omar adds the one bot, on a runner the lead's test does not use first
    const added = await applyGuarded(omar, `bots/${BOT}/BOT.md`, definition(BOT, 'team-pods'), `Add ${BOT}`);
    expect(added.status, added.text).toBe(201);
    await expect
      .poll(async () => (await world.stack.sql<{ status: string }>(`SELECT status FROM app.bots WHERE slug = $1`, [BOT]))[0]?.status, { timeout: 60_000, message: `the loader to make ${BOT}` })
      .toBe('active');
  } finally {
    await omar.ctx.dispose();
  }
  // The Codex runner of the seed waits for a sign-in (a pod would say it is ready once its login is checked; a stack has no pod): the status the pod controller would report is set once, as the seed does for Claude
  await world.stack.sql("UPDATE app.bot_runners SET status = 'ready', status_detail = NULL WHERE name = 'codex-chatgpt'");
  // Nadia is a plain member of Engineering in the seed; for this proof she is the team's lead (not a workspace admin)
  await world.stack.sql("UPDATE app.team_members SET role = 'lead' WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND actor_id = $1", [actorOf('nadia')]);
  hermes.setProfile(KINDS[0]!.profile, { apiKey: HERMES_KEY });
  bridge.setProfile(KINDS[1]!.profile, { apiKey: BRIDGE_KEY });
});

test.afterAll(async () => {
  await world?.stop();
  await hermes?.close();
  await bridge?.close();
  await llm?.close();
});

/** Changes `runs_on` in the definition as the lead does (Placement tab: read the file, change one line, propose and apply at once). */
async function place(nadia: Awaited<ReturnType<typeof apiOn>>, runner: string): Promise<void> {
  const blob = await nadia.get<{ content: string; blobSha: string }>(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(`bots/${BOT}/BOT.md`)}`);
  const changed = blob.content.replace(/^ {2}runs_on: .*$/m, `  runs_on: ${runner}`);
  expect(changed, 'the definition has a runs_on line').toContain(`runs_on: ${runner}`);
  const applied = await applyGuarded(nadia, `bots/${BOT}/BOT.md`, changed, `Place ${BOT} on ${runner}`, { baseBlobSha: blob.blobSha });
  expect(applied.status, applied.text).toBe(201);
  await expect
    .poll(async () => (await world.stack.sql<{ runs_on: string | null }>(`SELECT placement ->> 'runs_on' AS runs_on FROM app.bots WHERE slug = $1`, [BOT]))[0]?.runs_on, { timeout: 60_000, message: `the loader to read the placement on ${runner}` })
    .toBe(runner);
}

test('Nadia is a lead, not an admin: the admin routes are shut to her, and she cannot add a bot (that is for an admin)', async ({ playwright }) => {
  const nadia = await apiOn(playwright, world.stack, 'nadia');
  try {
    const shut = await nadia.ctx.get('/api/admin/bot-runners', { headers: await nadia.headers(), failOnStatusCode: false });
    expect([401, 403, 404]).toContain(shut.status());
    const added = await applyGuarded(nadia, 'bots/lead-extra/BOT.md', definition('lead-extra', 'office-hermes'), 'Add lead-extra');
    expect(added.status, added.text).toBeGreaterThanOrEqual(400);
    expect(added.text).toMatch(/workspace admin/i);
  } finally {
    await nadia.ctx.dispose();
  }
});

for (const kind of KINDS) {
  test(`Nadia places the bot on the ${kind.label} runner and the answer comes back`, async ({ browser, playwright }) => {
    const nadia = await apiOn(playwright, world.stack, 'nadia');
    try {
      // the runner is on the list her team may use
      const usable = await nadia.get<{ items: Array<{ name: string }> }>('/api/teams/engineering/bot-runners');
      expect(usable.items.map((r) => r.name), 'the runner is offered to the team').toContain(kind.runner);
      await place(nadia, kind.runner);
      bridgeAnswer = kind.answer;

      // the run of the last test is over (a mention that arrives while the bot's previous run is still closing is a race of the test, not of the product)
      await expect
        .poll(async () => (await world.stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.bot_runs r JOIN app.bots b ON b.id = r.bot_id WHERE b.slug = $1 AND r.ended_at IS NULL`, [BOT]))[0]?.n, { timeout: 30_000, message: 'the previous run to end' })
        .toBe('0');

      // she mentions the bot in #dev
      const dev = (await channelsOf(nadia))['dev']!;
      const callsBefore = { hermes: hermes.calls.length, bridge: bridge.calls.length, llm: llmCalls };
      const root = await postAs(nadia, dev, `@${BOT} hello from a lead on ${kind.label}`);

      // the answer of the runner's stand-in is posted in the channel by the bot
      let reply = '';
      try {
        await expect
          .poll(
            async () => {
              reply = (await world.stack.sql<{ body: string }>(`SELECT body FROM app.messages WHERE channel_id = $1 AND body LIKE $2 ORDER BY created_at DESC LIMIT 1`, [dev, `%${kind.answer}%`]))[0]?.body ?? '';
              return reply !== '';
            },
            { timeout: 60_000, message: `the ${kind.label} answer` },
          )
          .toBe(true);
      } catch (err) {
        // what the platform said instead (a refusal is a plain sentence in the thread), so a failure explains itself
        const latest = await world.stack.sql<{ body: string }>(`SELECT body FROM app.messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 3`, [dev]);
        const status = await world.stack.sql<{ name: string; status: string }>(`SELECT name, status FROM app.bot_runners WHERE name = $1`, [kind.runner]);
        const runs = await world.stack.sql<{ status: string; trigger_type: string }>(`SELECT r.status, r.trigger_type FROM app.bot_runs r JOIN app.bots b ON b.id = r.bot_id WHERE b.slug = $1 ORDER BY r.id DESC LIMIT 3`, [BOT]);
        throw new Error(`runs ${JSON.stringify(runs)}; ${err instanceof Error ? err.message : String(err)}; runner ${JSON.stringify(status)}; latest messages: ${JSON.stringify(latest.map((m) => m.body.slice(0, 200)))}; server log: ${world.stack.log().split('\n').filter((l) => /warn|error|run|route|trigger/i.test(l)).slice(-12).join(' | ').slice(0, 2500)}`);
      }
      expect(reply).toContain(kind.answer);
      // what came back holds no address, key or sign-in of the runner
      for (const secret of [hermes.url, bridge.url, llm.url, HERMES_KEY, BRIDGE_KEY]) expect(reply).not.toContain(secret);

      // the far end was really asked, by the profile the placement rule names, with the runner's key
      if (kind.runner === 'office-hermes') expect(hermes.calls.slice(callsBefore.hermes).some((c) => c.method === 'POST' && c.profile === kind.profile && c.authorized)).toBe(true);
      else if (kind.profile !== '') expect(bridge.calls.slice(callsBefore.bridge).some((c) => c.method === 'POST' && c.profile === kind.profile && c.authorized)).toBe(true);
      else expect(llmCalls - callsBefore.llm, 'the model server was called').toBeGreaterThan(0);

      // the thread beside the channel, for the gallery, at both sizes
      for (const [size, viewport, mobile] of [['1440', { width: 1440, height: 900 }, false] as const, ['390', { width: 390, height: 844 }, true] as const]) {
        const opened = await openOn(browser, playwright, world.stack, 'nadia', `/t/engineering/c/dev?panel=thread:${root.id}`, { viewport, mobile });
        try {
          await expect(opened.page.getByText(kind.answer).first()).toBeVisible({ timeout: 20_000 });
          expect(await noSidewaysScroll(opened.page)).toBe(true);
          await opened.page.screenshot({ path: join(SHOTS, `placement-${kind.runner}.${size}.png`) });
        } finally {
          await opened.context.close();
        }
      }
    } finally {
      await nadia.ctx.dispose();
    }
  });
}

test('the team pod kind (hermes_pod) is proved on the stage, not here: a stack has no cluster to run a pod in', async ({ playwright }) => {
  const nadia = await apiOn(playwright, world.stack, 'nadia');
  try {
    // what a stack can show: the runner is on the list the lead picks from
    const usable = await nadia.get<{ items: Array<{ name: string; kind: string }> }>('/api/teams/engineering/bot-runners');
    expect(usable.items.find((r) => r.name === 'team-pods')?.kind).toBe('hermes_pod');
  } finally {
    await nadia.ctx.dispose();
  }
});
