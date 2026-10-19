import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Persona journeys on the live site (PLAN §4 personas, §12 journey set): every persona signs in through the real form and walks the surfaces
 * built for them, desktop and phone, with the negatives they must meet (what they may not see). Read-only: nothing is posted, created or
 * approved, so no live side effect survives the run (opening a conversation view makes the person's own conversation channel with the bot,
 * which is the feature).
 *
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/personas/<persona>/NN-<step>.png plus a rebuilt index.html gallery and a
 * `journeys.json` result file (per persona, per step: passed, screenshot, note).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const mail = (who: string): string => `${who}@kahf.example`;

/** One step of one journey: a name, what it does, and the shot it leaves behind. */
interface Step {
  id: string;
  note: string;
  run: (page: Page) => Promise<void>;
}

interface Journey {
  persona: string;
  title: string;
  steps: Step[];
}

type Result = { persona: string; journey: string; step: string; note: string; passed: boolean; screenshot: string; error: string | null };
const results: Result[] = [];

test.beforeAll(() => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
});
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser, who: string, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(mail(who));
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, `${who} signs in with the screenshot password (is it current?)`).not.toHaveURL(/\/sign-in/);
  return page;
}

async function shoot(page: Page, name: string): Promise<string> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });
  return `${name}.png`;
}

async function frame(page: Page): Promise<void> {
  await expect(page.getByTestId('app-frame')).toBeVisible();
}

/** The channel is open to this persona (no denial). */
async function channel(page: Page, team: string, name: string): Promise<void> {
  await page.goto(`/t/${team}/c/${name}`);
  await frame(page);
  await expect(page.getByTestId('no-access')).toHaveCount(0);
}

/** The channel is closed to this persona: the denial is what the journey proves. */
async function denied(page: Page, team: string, name: string): Promise<void> {
  await page.goto(`/t/${team}/c/${name}`);
  await frame(page);
  await expect(page.getByTestId('no-access')).toBeVisible();
}

const journeys: Journey[] = [
  {
    persona: 'omar',
    title: 'the workspace owner: models, teams, bots and the audit',
    steps: [
      { id: 'llm', note: 'Workspace -> LLM: providers, aliases and budgets', run: async (page) => { await page.goto('/settings/workspace/llm'); await frame(page); } },
      { id: 'teams', note: 'the teams of the workspace', run: async (page) => { await page.goto('/teams'); await frame(page); } },
      { id: 'bots', note: 'the Engineering bot roster', run: async (page) => { await page.goto('/t/engineering/bots'); await expect(page.getByTestId('bots-roster')).toBeVisible(); } },
      { id: 'bot-page', note: "one bot's page (its Audit tab is the audit trail)", run: async (page) => { await page.goto('/t/engineering/bots/coder'); await expect(page.getByTestId('bots-roster')).toHaveCount(0); } },
      { id: 'approvals', note: 'the approvals inbox the owner also clears', run: async (page) => { await page.goto('/t/engineering/approvals'); await expect(page.getByTestId('approvals-inbox')).toBeVisible(); } },
      { id: 'members', note: 'workspace members and their roles', run: async (page) => { await page.goto('/settings/workspace/members'); await frame(page); } },
    ],
  },
  {
    persona: 'nadia',
    title: 'the engineer: channels, threads, the coder, memory and files',
    steps: [
      { id: 'channel', note: '#dev: the channel she works in', run: async (page) => channel(page, 'engineering', 'dev') },
      { id: 'threads', note: 'her Threads inbox', run: async (page) => { await page.goto('/t/engineering/threads'); await expect(page.getByTestId('threads-inbox')).toBeVisible(); } },
      { id: 'coder-chat', note: 'her conversation with Coder', run: async (page) => { await page.goto('/t/engineering/bots/coder/chat'); await expect(page.getByTestId('conversation-view')).toBeVisible(); } },
      { id: 'brain-chat', note: 'her conversation with Brain', run: async (page) => { await page.goto('/t/engineering/bots/brain/chat'); await expect(page.getByTestId('conversation-view')).toBeVisible(); } },
      { id: 'memory', note: "the team's memory: concepts, trust tiers and provenance", run: async (page) => { await page.goto('/t/engineering/memory'); await frame(page); } },
      { id: 'files', note: "Files: the team's repository, `memory/` among it", run: async (page) => { await page.goto('/t/engineering/files'); await frame(page); } },
      { id: 'leads-denied', note: 'a private channel she is not in is closed to her', run: async (page) => denied(page, 'customer-support', 'support') },
    ],
  },
  {
    persona: 'rafi',
    title: 'the on-call approver: approvals, incidents and the runbook',
    steps: [
      { id: 'approvals', note: 'the approvals inbox he clears', run: async (page) => { await page.goto('/t/engineering/approvals'); await expect(page.getByTestId('approvals-inbox')).toBeVisible(); } },
      { id: 'incidents', note: '#incidents: the alerts he follows', run: async (page) => channel(page, 'engineering', 'incidents') },
      { id: 'alerts', note: '#alerts', run: async (page) => channel(page, 'engineering', 'alerts') },
      { id: 'brain-chat', note: 'he asks Brain for the runbook', run: async (page) => { await page.goto('/t/engineering/bots/brain/chat'); await expect(page.getByTestId('conversation-view')).toBeVisible(); } },
      { id: 'support-denied', note: "Support's channels are not his", run: async (page) => denied(page, 'customer-support', 'support') },
    ],
  },
  {
    persona: 'sameera',
    title: 'the support agent: the support channels, the responder and the knowledge',
    steps: [
      { id: 'support', note: '#support: where her work happens', run: async (page) => channel(page, 'customer-support', 'support') },
      { id: 'enquiries', note: '#enquiries', run: async (page) => channel(page, 'customer-support', 'enquiries') },
      { id: 'escalations', note: '#escalations', run: async (page) => channel(page, 'customer-support', 'escalations') },
      { id: 'kb-updates', note: '#kb-updates', run: async (page) => channel(page, 'customer-support', 'kb-updates') },
      { id: 'responder-chat', note: 'her conversation with the Support responder', run: async (page) => { await page.goto('/t/customer-support/bots/support-responder/chat'); await expect(page.getByTestId('conversation-view')).toBeVisible(); } },
      { id: 'engineering-denied', note: "Engineering is invisible to her", run: async (page) => denied(page, 'engineering', 'dev') },
    ],
  },
  {
    persona: 'tariq',
    title: 'the marketing lead: content, campaigns, files and the drafter',
    steps: [
      { id: 'content', note: '#content: where the posts are drafted', run: async (page) => channel(page, 'marketing', 'content') },
      { id: 'campaigns', note: '#campaigns', run: async (page) => channel(page, 'marketing', 'campaigns') },
      { id: 'analytics', note: '#analytics', run: async (page) => channel(page, 'marketing', 'analytics') },
      { id: 'brand', note: '#brand', run: async (page) => channel(page, 'marketing', 'brand') },
      { id: 'files', note: "Marketing's files", run: async (page) => { await page.goto('/t/marketing/files'); await frame(page); } },
      { id: 'drafter-chat', note: 'his conversation with the Content drafter', run: async (page) => { await page.goto('/t/marketing/bots/content-drafter/chat'); await expect(page.getByTestId('conversation-view')).toBeVisible(); } },
      { id: 'support-denied', note: "Support's mail is not his", run: async (page) => denied(page, 'customer-support', 'support') },
    ],
  },
  {
    persona: 'priya',
    title: 'the new joiner: reading, following and asking, with no write controls',
    steps: [
      { id: 'home', note: 'her first screen', run: async (page) => { await page.goto('/'); await frame(page); } },
      { id: 'channel', note: '#general: the channel she is a member of', run: async (page) => channel(page, 'engineering', 'general') },
      { id: 'threads', note: 'the Threads inbox', run: async (page) => { await page.goto('/t/engineering/threads'); await expect(page.getByTestId('threads-inbox')).toBeVisible(); } },
      { id: 'memory', note: "the team's memory, which she may read", run: async (page) => { await page.goto('/t/engineering/memory'); await frame(page); } },
      { id: 'approvals-denied', note: 'the approvals inbox is not hers', run: async (page) => { await page.goto('/t/engineering/approvals'); await expect(page.getByTestId('no-access').or(page.getByRole('heading', { name: 'You do not have access' }))).toBeVisible(); } },
    ],
  },
  {
    persona: 'lena',
    title: 'the guest: one channel, nothing else',
    steps: [
      { id: 'releases', note: '#releases: the only channel she was added to', run: async (page) => channel(page, 'engineering', 'releases') },
      { id: 'dev-denied', note: '#dev is closed to her', run: async (page) => denied(page, 'engineering', 'dev') },
      { id: 'bots-denied', note: 'the bots page is closed to her', run: async (page) => { await page.goto('/t/engineering/bots'); await expect(page.getByTestId('no-access').or(page.getByRole('heading', { name: 'You do not have access' }))).toBeVisible(); } },
      { id: 'files-denied', note: 'Files is closed to her', run: async (page) => { await page.goto('/t/engineering/files'); await expect(page.getByTestId('no-access').or(page.getByRole('heading', { name: 'You do not have access' }))).toBeVisible(); } },
    ],
  },
];

for (const journey of journeys) {
  test(`${journey.persona}: ${journey.title}`, async ({ browser }) => {
    const page = await signIn(browser, journey.persona, DESKTOP);
    try {
      let n = 0;
      for (const step of journey.steps) {
        n += 1;
        const name = `personas/${journey.persona}/${String(n).padStart(2, '0')}-${step.id}`;
        try {
          await step.run(page);
          const shot = await shoot(page, name);
          results.push({ persona: journey.persona, journey: journey.title, step: step.id, note: step.note, passed: true, screenshot: shot, error: null });
        } catch (err) {
          let shot = '';
          try {
            shot = await shoot(page, `${name}-FAILED`);
          } catch {
            /* the page may be gone */
          }
          results.push({ persona: journey.persona, journey: journey.title, step: step.id, note: step.note, passed: false, screenshot: shot, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      await page.context().close();
    }
  });
}

test('nadia and priya: the same screens at phone width', async ({ browser }) => {
  for (const who of ['nadia', 'priya']) {
    const page = await signIn(browser, who, PHONE);
    try {
      const steps: Step[] = [
        { id: 'channel-phone', note: 'the channel at 390 px', run: async (p) => channel(p, 'engineering', who === 'nadia' ? 'dev' : 'general') },
        { id: 'memory-phone', note: 'the memory screen at 390 px', run: async (p) => { await p.goto('/t/engineering/memory'); await frame(p); } },
      ];
      let n = 0;
      for (const step of steps) {
        n += 1;
        const name = `personas/${who}/${String(n).padStart(2, '0')}-${step.id}`;
        try {
          await step.run(page);
          const shot = await shoot(page, name);
          results.push({ persona: who, journey: 'phone width', step: step.id, note: step.note, passed: true, screenshot: shot, error: null });
        } catch (err) {
          results.push({ persona: who, journey: 'phone width', step: step.id, note: step.note, passed: false, screenshot: '', error: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      await page.context().close();
    }
  }
});

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'journeys.json'), JSON.stringify({ site: BASE, at: new Date().toISOString(), results }, null, 2));
  const failures = results.filter((r) => !r.passed);
  // eslint-disable-next-line no-console
  console.log(`persona journeys: ${results.length - failures.length}/${results.length} steps passed`);
  for (const f of failures) console.log(`  FAIL ${f.persona}/${f.step}: ${f.error}`);
});
