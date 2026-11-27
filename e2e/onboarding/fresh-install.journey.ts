/* eslint-disable @typescript-eslint/no-explicit-any -- the live API answers are read as loose JSON, like the other live scripts */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  ask,
  channelIdOf,
  dmChannel,
  isDone,
  Journey,
  listRunners,
  openStep,
  placeBot,
  readEnv,
  setUpPodAgent,
  showStep,
  showThread,
  signInAndChoosePassword,
  skip,
  stepInfrastructure,
  stepModels,
  stepOrganization,
  stepRunnersPod,
  stepServers,
  stepSignin,
  stepTeams,
  stepTheme,
  tag,
  uploadSignin,
  waitRunnerReady,
  warmUp,
  wizardFirstView,
  type BotPlan,
  type RunnerWish,
} from './journey-lib.ts';

/*
 * The fresh-install journey (task P38-05b): one run through a site that was just installed (the install profile, no demo data), the way its first admin meets it.
 * Run it with `journey.config.ts`; `docs/guide/fresh-install/README.md` lists the environment variables. Every step is numbered, shot at 1440 by 900, and written
 * to `fresh-install-report.json` with its seconds and whether it passed, failed or was skipped (and why). Nothing hangs: each wait has a bound, and a step that
 * cannot start says "skipped: <reason>" and the run goes on.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

test.describe.configure({ mode: 'serial' });

const BOT_SLUG: Record<RunnerWish, string> = { host: 'journey-host', pod: 'journey-pod', claude: 'journey-claude', codex: 'journey-codex' };
const WISH_TITLE: Record<RunnerWish, string> = { host: 'this machine (Hermes on the host)', pod: 'the Hermes pod', claude: 'the Claude Code pod', codex: 'the Codex pod' };

/** The runner a wish means, as the site lists it now; null when it does not exist (yet). */
async function runnerFor(j: Journey, wish: RunnerWish): Promise<any | null> {
  const all = await listRunners(j);
  const ok = (r: any): boolean => r.enabled !== false;
  switch (wish) {
    case 'host':
      return all.filter(ok).find((r) => r.kind === 'server_agent' && (/hermes/i.test(String(r.agent)) || /-hermes$/.test(r.name))) ?? null;
    case 'pod':
      return all.filter(ok).find((r) => r.kind === 'hermes_pod') ?? null;
    case 'claude':
      return all.filter(ok).find((r) => r.kind === 'claude_cli') ?? null;
    case 'codex':
      return all.filter(ok).find((r) => r.kind === 'codex_cli') ?? null;
  }
}

const sha12 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** The questions one runner's bot is asked: a channel mention, a direct message, a fact told in one place and asked in another, and (the coding agents) a small job. */
async function exerciseRunner(j: Journey, wish: RunnerWish): Promise<void> {
  const slug = BOT_SLUG[wish];
  const coding = wish === 'claude' || wish === 'codex';
  const title = WISH_TITLE[wish];
  const ready = wish === 'host' ? 'servers' : wish === 'pod' ? 'runners' : `runner-${wish}-upload`;

  await j.step(`bot-${wish}`, `A bot on ${title}`, async () => {
    const runner = await runnerFor(j, wish);
    if (!runner) return skip(`there is no ${title} runner (an earlier step did not make one)`);
    // a Claude Code or Codex pod starts only when a bot is placed on it ("No bot is placed on this runner yet, so its pod is stopped"): place the bot, then wait
    const plan: BotPlan = { slug, wish, runner: runner.name, coding };
    const how = await placeBot(j, plan);
    j.facts.set(`bot-${wish}`, slug);
    const waited = Date.now();
    const ok = runner.status === 'ready' ? runner : await waitRunnerReady(j, (r) => r.id === runner.id, j.env.podWaitS);
    await j.page.goto('/settings/workspace/runners');
    await expect(j.page.locator(`[data-testid="runner-row"][data-runner="${ok.name}"]`)).toBeVisible({ timeout: 30_000 });
    await j.shot(`runners-${wish}-ready`, { main: true });
    await j.page.goto(`/t/${j.env.team}/bots/${slug}`);
    await expect(j.page.getByText(slug, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await j.shot(`bot-${wish}-page`);
    const warm = await warmUp(j, { slug, runner: wish, timeoutS: j.env.podWaitS });
    return `${how} on ${ok.name}; the runner was ready ${Math.round((Date.now() - waited) / 1000)} s after the bot was placed and the bot first answered ${warm.seconds} s after that (${warm.tries} tries)`;
  }, { needs: [ready], budgetS: 2 * j.env.podWaitS + 300 });

  const channelWord = tag();
  await j.step(`ask-channel-${wish}`, `A question in a channel to the ${wish} bot`, async () => {
    const dev = await channelIdOf(j, 'dev');
    const asked = await ask(j, { channelId: dev, runner: wish, where: 'channel', text: `@${slug} Please answer in one short sentence and include this code word exactly as written: ${channelWord}.` });
    expect(asked.answer).toContain(channelWord);
    await showThread(j, { where: 'channel', bot: slug, rootId: asked.rootId, channel: 'dev', name: `${wish}-channel-answer`, expect: channelWord });
    return `answered in ${asked.seconds} s`;
  }, { needs: [`bot-${wish}`], budgetS: j.env.answerTimeoutS + 120 });

  const dmWord = tag();
  await j.step(`ask-dm-${wish}`, `A direct message to the ${wish} bot`, async () => {
    const dm = await dmChannel(j, slug);
    const asked = await ask(j, { channelId: dm, runner: wish, where: 'dm', text: `Please answer in one short sentence and include this code word exactly as written: ${dmWord}.` });
    expect(asked.answer).toContain(dmWord);
    await showThread(j, { where: 'dm', bot: slug, rootId: asked.rootId, channel: 'dev', name: `${wish}-dm-answer`, expect: dmWord });
    return `answered in ${asked.seconds} s`;
  }, { needs: [`bot-${wish}`], budgetS: j.env.answerTimeoutS + 120 });

  const fact = `${tag()}${tag()}`;
  // a second run on the same site finds the first run's word in the bot's memory too: the question names this run
  const runTag = tag();
  await j.step(`memory-${wish}`, `The ${wish} bot remembers a fact told in another message`, async () => {
    const dev = await channelIdOf(j, 'dev');
    const told = await ask(j, { channelId: dev, runner: wish, where: 'channel', text: `@${slug} Remember this for later: my journey word for the run ${runTag} is ${fact}. Save it with your memory tool and tell me you did.` });
    await showThread(j, { where: 'channel', bot: slug, rootId: told.rootId, channel: 'dev', name: `${wish}-memory-told`, expect: told.answer });
    const dm = await dmChannel(j, slug);
    const back = await ask(j, { channelId: dm, runner: wish, where: 'dm', text: `What is my journey word for the run ${runTag}? Look it up in your memory with your memory tool, then answer with that word.` });
    expect(back.answer).toContain(fact);
    await showThread(j, { where: 'dm', bot: slug, rootId: back.rootId, channel: 'dev', name: `${wish}-memory-asked`, expect: fact });
    return `told in a channel, asked in a DM, answered in ${back.seconds} s`;
  }, { needs: [`bot-${wish}`], budgetS: 2 * j.env.answerTimeoutS + 180 });

  if (coding) {
    const word = tag();
    const content = `${word}\n`;
    await j.step(`code-${wish}`, `A small coding task for the ${wish} bot`, async () => {
      const dev = await channelIdOf(j, 'dev');
      const asked = await ask(j, {
        channelId: dev,
        runner: wish,
        where: 'channel',
        timeoutS: Math.max(j.env.answerTimeoutS, 600),
        text:
          `@${slug} ${j.env.starter ? "In the team's starter repository" : 'In your working folder'}, create the file journey/${word}.txt that holds the single line ${word} followed by one newline (for example with \`printf '%s\\n' ${word}\`). Then run \`sha256sum journey/${word}.txt\` and ` +
          'tell me the first 12 characters of the hash and whether the file is there.',
      });
      // the hash of a file only a real shell run can know (the bot cannot guess it)
      expect(asked.answer.toLowerCase()).toContain(sha12(content));
      await showThread(j, { where: 'channel', bot: slug, rootId: asked.rootId, channel: 'dev', name: `${wish}-coding-task`, expect: sha12(content) });
      return `the file was made and hashed in ${asked.seconds} s`;
    }, { needs: [`bot-${wish}`], budgetS: Math.max(j.env.answerTimeoutS, 600) + 180 });
  }
}

test('a fresh install, from the first sign-in to four runners that answer', async ({ browser }) => {
  test.setTimeout(0);
  const env = readEnv();
  const context = await browser.newContext({ baseURL: env.url, ignoreHTTPSErrors: true, viewport: DESKTOP, reducedMotion: 'reduce', colorScheme: 'light' });
  const first = await context.newPage();
  const j = new Journey(env, first);
  j.log(`the journey starts; shots go to ${env.shotsDir}; runners: ${[...env.runners].join(', ')}`);

  // ---- 1. the first sign-in ---------------------------------------------------------------------------------------------------------------------------
  const signedIn = await j.step('sign-in', 'Sign in with the installer password and choose a new one', () => signInAndChoosePassword(j), { budgetS: 180, always: true });
  if (signedIn.status !== 'pass') {
    j.writeReport();
    await context.close();
    throw new Error(`the first sign-in did not work (${signedIn.reason ?? 'unknown'}): nothing else can run`);
  }

  // ---- 2. the wizard, step by step --------------------------------------------------------------------------------------------------------------------
  await j.step('wizard', 'The setup wizard opens with its thirteen steps', () => wizardFirstView(j), { needs: ['sign-in'], budgetS: 120 });
  await j.step('bootstrap', 'Step 1: the first sign-in is done', async () => {
    const step = await openStep(j, 'bootstrap');
    await showStep(step);
    await j.shot('wizard-bootstrap');
    expect(await isDone(step)).toBe(true);
    return 'done from the fact that the first admin signed in';
  }, { needs: ['sign-in'], budgetS: 120 });
  await j.step('theme', 'Step 2: the look', () => stepTheme(j), { needs: ['sign-in'], budgetS: 180 });
  await j.step('organization', 'Step 3: the organization', () => stepOrganization(j), { needs: ['sign-in'], budgetS: 180 });
  await j.step('infrastructure', 'Step 4: the address and HTTPS', () => stepInfrastructure(j), { needs: ['sign-in'], budgetS: 120 });
  await j.step('models', 'Step 5: the models (the key is entered here, then each alias is tested)', () => stepModels(j), { needs: ['sign-in'], budgetS: 900 });
  await j.step('signin-policy', 'Step 6: how people sign in', () => stepSignin(j), { needs: ['sign-in'], budgetS: 180 });
  await j.step('teams', 'Step 7: the teams (every template is made)', () => stepTeams(j), { needs: ['sign-in'], budgetS: 900 });
  await j.step('servers', 'Step 8: this machine as a server', () => stepServers(j), { needs: ['sign-in'], budgetS: env.enrollWaitS + 300 });
  await j.step('runners', 'Step 9: the Hermes pod answers a real question', () => stepRunnersPod(j), { needs: ['models', 'teams'], budgetS: env.podWaitS + 300 });

  // the Claude Code and Codex pods: the wizard makes the runner, the Runners page takes the sign-in file
  for (const [wish, kind, dir, file] of [
    ['claude', 'claude_cli', env.claudeDir, '.credentials.json'],
    ['codex', 'codex_cli', env.codexDir, 'auth.json'],
  ] as const) {
    await j.step(`runner-${wish}-make`, `The ${wish === 'claude' ? 'Claude Code' : 'Codex'} pod runner`, async () => {
      if (!env.runners.has(wish)) return skip(`${wish} is not in JOURNEY_RUNNERS`);
      return setUpPodAgent(j, kind);
    }, { needs: ['runners'], budgetS: 300 });
    await j.step(`runner-${wish}-upload`, `The ${wish === 'claude' ? 'Claude Code' : 'Codex'} sign-in file goes in through the Runners page`, async () => {
      if (!dir) return skip(`no sign-in directory given (JOURNEY_${wish.toUpperCase()}_SIGNIN_DIR)`);
      const path = join(dir, file);
      if (!existsSync(path)) return skip(`${file} is not in the sign-in directory`);
      return uploadSignin(j, kind, path);
    }, { needs: [`runner-${wish}-make`], budgetS: 300 });
  }

  // ---- 3. the bots, per runner ------------------------------------------------------------------------------------------------------------------------
  await j.step('bots', 'Step 10: where bots run', async () => {
    const step = await openStep(j, 'bots');
    await showStep(step);
    await j.shot('wizard-bots-before');
    if (!(await isDone(step))) {
      const set = j.page.getByTestId('ob-bots-set');
      if (await set.isVisible().catch(() => false)) await set.click();
      await expect(step).toHaveAttribute('data-done', 'true', { timeout: 60_000 });
    }
    await showStep(step);
    await j.shot('wizard-bots-set', { main: true });
    return 'bots have a default runner';
  }, { needs: ['runners'], budgetS: 180 });

  for (const wish of ['host', 'pod', 'claude', 'codex'] as const) {
    if (!env.runners.has(wish)) {
      j.log(`${wish}: left out (JOURNEY_RUNNERS)`);
      continue;
    }
    await exerciseRunner(j, wish);
  }

  await j.step('runners-page', 'The Runners page: every pod and its state', async () => {
    await j.page.goto('/settings/workspace/runners');
    await expect(j.page.getByTestId('runner-row').first()).toBeVisible({ timeout: 30_000 });
    await j.shot('runners-all', { main: true, full: true });
    const rows = await j.page.getByTestId('runner-row').count();
    const list = await listRunners(j);
    return `${rows} runners: ${list.map((r) => `${r.name}=${r.status}`).join(', ')}`;
  }, { needs: ['sign-in'], budgetS: 120 });

  // ---- 4. code, Brain, the first delivery -------------------------------------------------------------------------------------------------------------
  let projectTeam = env.team;
  await j.step('code', 'Step 11: the starter repository is connected', async () => {
    const step = await openStep(j, 'code');
    const starter = env.starter;
    if (!(await isDone(step))) {
      if (!starter) return skip('no starter repository given (JOURNEY_STARTER_REPO)');
      await j.page.getByTestId('ob-project-name').fill('starter');
      await j.page.getByTestId('ob-project-repo').fill(starter.repo);
      await showStep(step);
      await j.shot('wizard-code-form');
      await j.page.getByTestId('ob-project-add').click();
      await expect(step).toHaveAttribute('data-done', 'true', { timeout: 60_000 });
    }
    const href = (await step.getByRole('link', { name: /Open Projects|Add the access token/ }).first().getAttribute('href').catch(() => null)) ?? '';
    projectTeam = /^\/t\/([^/]+)\//.exec(href)?.[1] ?? projectTeam;
    let note = 'a project is connected';
    if (starter && starter.token !== '' && starter.user !== '') {
      const list = await j.must('GET', `/api/teams/${projectTeam}/projects`);
      const project = (list.items as any[]).find((p) => p.name === 'starter') ?? (list.items as any[])[0];
      if (project) {
        await j.must('PUT', `/api/teams/${projectTeam}/projects/${project.id}/push-credential`, { username: starter.user, token: starter.token });
        note = 'the project holds its access token';
      }
    }
    await showStep(step);
    await j.shot('wizard-code-connected', { main: true });
    return note;
  }, { needs: ['teams'], budgetS: 300 });

  await j.step('launch', 'Step 12: Brain answers with sources', async () => {
    const step = await openStep(j, 'launch');
    if (!(await isDone(step))) {
      const ask = j.page.getByTestId('ob-launch-ask');
      if (!(await ask.isVisible().catch(() => false))) return skip('Brain is not on a team yet');
      await showStep(step);
      await j.shot('wizard-launch-form');
      await ask.click();
      await expect(step).toHaveAttribute('data-done', 'true', { timeout: 420_000 });
    }
    await showStep(step);
    await j.shot('wizard-launch-answered', { main: true });
    const link = step.getByRole('link', { name: 'Open the conversation' }).first();
    if ((await link.count()) === 0) return 'Brain answered';
    await link.click();
    const cited = j.page.getByTestId('answer-citations');
    await cited.first().waitFor({ timeout: 60_000 }).catch(() => undefined);
    await j.shot('brain-answer', { main: true });
    if ((await cited.count()) === 0) throw new Error('Brain answered, but the answer shows no cited sources');
    return `Brain answered with ${await j.page.getByTestId('answer-citation').count()} cited sources`;
  }, { needs: ['models', 'teams', 'runners'], budgetS: 600 });

  await j.step('delivery', 'Step 13: the first delivery (the Engineer to a pull request)', async () => {
    if (!env.delivery) return skip('left out (JOURNEY_DELIVERY=0)');
    const step = await openStep(j, 'delivery');
    if (!(await isDone(step))) {
      const start = j.page.getByTestId('ob-delivery-start');
      if (!(await start.isVisible().catch(() => false))) {
        if (!(await step.locator('[data-testid="ob-runs"]').isVisible().catch(() => false))) return skip('the delivery cannot be started (the Engineer needs the Engineering team and a project with a token)');
      } else {
        if (!(await start.isEnabled())) return skip('the delivery button is shut: the required steps are not all done');
        await showStep(step);
        await j.shot('wizard-delivery-offer');
        await start.click();
      }
      const until = Date.now() + env.deliveryWaitMin * 60_000;
      let shotRuns = false;
      while (Date.now() < until) {
        if (await isDone(step)) break;
        if (!shotRuns && (await step.getByTestId('ob-runs').isVisible().catch(() => false))) {
          shotRuns = true;
          await showStep(step);
          await j.shot('wizard-delivery-running', { replay: false });
        }
        if (env.approve) {
          const waiting = await j.must('GET', `/api/teams/${projectTeam}/approvals`).catch(() => ({ waiting: 0 }));
          if (waiting.waiting > 0) {
            await j.page.goto(`/t/${projectTeam}/approvals`);
            const button = j.page.getByTestId('approval-row-approve').first();
            if (await button.isVisible({ timeout: 10_000 }).catch(() => false)) {
              await j.shot('approvals-waiting', { replay: false });
              await button.click();
              await j.page.waitForTimeout(2_000);
            }
            await j.page.goto('/onboarding?step=delivery');
          }
        }
        await j.page.waitForTimeout(20_000);
        await j.page.reload();
      }
      if (!(await isDone(step))) throw new Error(`the delivery was not done within ${env.deliveryWaitMin} min${env.approve ? '' : ' (approvals are not pressed unless JOURNEY_APPROVE=1)'}`);
    }
    await showStep(step);
    await j.shot('wizard-delivery-done', { main: true });
    return 'the first delivery is done';
  }, { needs: ['code', 'launch'], budgetS: env.deliveryWaitMin * 60 + 300 });

  await j.step('wizard-end', 'The wizard at the end', async () => {
    await j.page.goto('/onboarding');
    await expect(j.page.getByRole('heading', { name: /Finish setting up|all set|done/i }).first()).toBeVisible({ timeout: 30_000 });
    await j.shot('wizard-end', { main: true, full: true });
    const open = await j.page.locator('[data-landmark="steps"] [data-step]:not([data-done="true"])').evaluateAll((els) => els.map((e) => e.getAttribute('data-step')));
    return open.length === 0 ? 'all thirteen steps are done' : `still open: ${open.join(', ')}`;
  }, { needs: ['sign-in'], budgetS: 120 });

  // ---- 5. the phone pass: the same pages at 390 by 844, the main ones in the dark look too ---------------------------------------------------------------
  if (env.passes.has('mobile')) {
    await j.step('phone', 'The same pages at 390 by 844, light and dark', async () => {
      const state = await context.storageState();
      const phone = await browser.newContext({ baseURL: env.url, ignoreHTTPSErrors: true, viewport: PHONE, isMobile: true, hasTouch: true, reducedMotion: 'reduce', storageState: state, colorScheme: 'light' });
      try {
        const page = await phone.newPage();
        const seen = new Set<string>();
        const visits = j.visited.filter((v) => (seen.has(v.path) ? false : (seen.add(v.path), true))).slice(0, 36);
        let sideways = 0;
        for (const v of visits) {
          await page.emulateMedia({ colorScheme: 'light' });
          await page.goto(v.path);
          await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
          await page.waitForTimeout(600);
          await j.phoneShot(page, v.name, 'light');
          const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
          if (!fits) sideways += 1;
          if (v.main) {
            await page.emulateMedia({ colorScheme: 'dark' });
            await page.waitForTimeout(400);
            await j.phoneShot(page, v.name, 'dark');
          }
        }
        if (sideways > 0) throw new Error(`${sideways} of ${visits.length} pages scroll sideways at 390 wide`);
        return `${visits.length} pages, none scrolls sideways`;
      } finally {
        await phone.close();
      }
    }, { needs: ['sign-in'], budgetS: 900 });
  }

  j.writeReport();
  const sum = j.summary();
  j.log(`finished: ${sum.pass} passed, ${sum.fail} failed, ${sum.skipped} skipped; the report is ${join(env.shotsDir, 'fresh-install-report.json')}`);
  await context.close();
  expect(sum.fail, `steps that failed: ${j.steps.filter((s) => s.status === 'fail').map((s) => s.id).join(', ')}`).toBe(0);
});
