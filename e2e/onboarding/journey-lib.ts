/* eslint-disable @typescript-eslint/no-explicit-any -- the live API answers are read as loose JSON, like the other live scripts (e2e/screens/task.*.shots.ts) */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

/*
 * The helpers of the fresh-install journey (task P38-05b). `fresh-install.journey.ts` runs them against a freshly installed site and
 * `fresh-install.local.spec.ts` runs the same helpers against an isolated stack with stand-ins, so they are proved before the real run.
 *
 * Rules the helpers keep:
 *  - Every address, sign-in, key and token comes from the environment (`readEnv`). Nothing here has a default for a real address, and nothing is written to
 *    disk about a password: the report and every message pass through `scrub`, which replaces the values of the secrets and the site's address.
 *  - A step records pass, fail or "skipped: <reason>" and never hangs: every wait has a bound and a step also has a hard budget.
 *  - A step is ticked from facts: running the journey again after the wizard is partly done skips the work that is already done and says so.
 *  - Every screenshot is masked first: each address and e-mail on the page gets a solid box over it (text is left in place, so the page keeps working).
 */

// ---- the environment ---------------------------------------------------------------------------------------------------------------------------------

export type RunnerWish = 'host' | 'pod' | 'claude' | 'codex';
export const ALL_RUNNERS: readonly RunnerWish[] = ['host', 'pod', 'claude', 'codex'];

export interface JourneyEnv {
  url: string;
  email: string;
  password: string;
  newPassword: string;
  org: string;
  team: string;
  serverLabel: string;
  model: { preset: string; baseUrl: string; name: string; key: string } | null;
  shotsDir: string;
  /** `''` no gallery, `desktop` only the 1440 shots, `all` every shot. Written to docs/guide/fresh-install/. */
  gallery: '' | 'desktop' | 'all';
  mask: boolean;
  maskWords: string[];
  enrollRunner: string | null;
  enrollWaitS: number;
  /** A reason the server step is not tried at all (this machine already serves another site, or none is at hand): the step and the host runner's steps say so and skip. */
  noServer: string | null;
  claudeDir: string | null;
  codexDir: string | null;
  starter: { repo: string; user: string; token: string } | null;
  only: Set<string>;
  skipIds: Set<string>;
  runners: Set<RunnerWish>;
  answerTimeoutS: number;
  podWaitS: number;
  deliveryWaitMin: number;
  delivery: boolean;
  approve: boolean;
  passes: Set<'desktop' | 'mobile'>;
}

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v: string | undefined, dflt: number): number => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : dflt);

/** The place the gallery is written to when `JOURNEY_GALLERY` is set. */
export const GALLERY_DIR = join(import.meta.dirname, '..', '..', 'docs', 'guide', 'fresh-install');

/** Reads the journey's settings. Throws one sentence naming the variables that are missing (never a value). */
export function readEnv(e: NodeJS.ProcessEnv = process.env): JourneyEnv {
  const missing = ['JOURNEY_URL', 'JOURNEY_ADMIN_EMAIL', 'JOURNEY_ADMIN_PASSWORD', 'JOURNEY_NEW_PASSWORD'].filter((k) => !e[k]);
  if (missing.length > 0) throw new Error(`The journey needs these environment variables: ${missing.join(', ')}.`);
  const keyVar = e['JOURNEY_MODEL_KEY_ENV'];
  const key = (keyVar ? e[keyVar] : e['JOURNEY_MODEL_KEY']) ?? '';
  const baseUrl = e['JOURNEY_MODEL_BASE_URL'] ?? '';
  const preset = e['JOURNEY_MODEL_PRESET'] ?? 'other-plan';
  const wish = list(e['JOURNEY_RUNNERS']);
  const galleryRaw = (e['JOURNEY_GALLERY'] ?? '').toLowerCase();
  const gallery: JourneyEnv['gallery'] = galleryRaw === 'desktop' ? 'desktop' : galleryRaw === '' || galleryRaw === '0' ? '' : 'all';
  const passes = list(e['JOURNEY_PASS']);
  return {
    url: (e['JOURNEY_URL'] as string).replace(/\/+$/, ''),
    email: e['JOURNEY_ADMIN_EMAIL'] as string,
    password: e['JOURNEY_ADMIN_PASSWORD'] as string,
    newPassword: e['JOURNEY_NEW_PASSWORD'] as string,
    org: e['JOURNEY_ORG_NAME'] ?? 'Fresh Install Co',
    team: e['JOURNEY_TEAM'] ?? 'engineering',
    serverLabel: e['JOURNEY_SERVER_LABEL'] ?? 'Devbox',
    // the key is required; the address is required for a preset that has none of its own
    model: key !== '' ? { preset, baseUrl, name: e['JOURNEY_MODEL_NAME'] ?? '', key } : null,
    shotsDir: e['JOURNEY_SHOTS_DIR'] ?? join(tmpdir(), 'manythreads-journey'),
    gallery,
    // a gallery that goes into the repository is always masked; `JOURNEY_MASK=0` only turns the masking off for a private debugging run
    mask: gallery !== '' || e['JOURNEY_MASK'] !== '0',
    maskWords: list(e['JOURNEY_MASK_WORDS']),
    enrollRunner: e['JOURNEY_ENROLL_CMD_RUNNER'] || null,
    enrollWaitS: num(e['JOURNEY_ENROLL_WAIT_S'], 900),
    noServer: e['JOURNEY_NO_SERVER'] || null,
    claudeDir: e['JOURNEY_CLAUDE_SIGNIN_DIR'] || null,
    codexDir: e['JOURNEY_CODEX_SIGNIN_DIR'] || null,
    starter: e['JOURNEY_STARTER_REPO'] ? { repo: e['JOURNEY_STARTER_REPO'], user: e['JOURNEY_STARTER_USER'] ?? '', token: e['JOURNEY_STARTER_TOKEN'] ?? '' } : null,
    only: new Set(list(e['JOURNEY_ONLY'])),
    skipIds: new Set(list(e['JOURNEY_SKIP'])),
    runners: new Set(wish.length > 0 ? (wish.filter((w) => (ALL_RUNNERS as readonly string[]).includes(w)) as RunnerWish[]) : ALL_RUNNERS),
    answerTimeoutS: num(e['JOURNEY_ANSWER_TIMEOUT_S'], 300),
    podWaitS: num(e['JOURNEY_POD_WAIT_S'], 900),
    deliveryWaitMin: num(e['JOURNEY_DELIVERY_WAIT_MIN'], 60),
    delivery: e['JOURNEY_DELIVERY'] !== '0',
    approve: e['JOURNEY_APPROVE'] === '1',
    passes: new Set((passes.length > 0 ? passes : ['desktop', 'mobile']).filter((p): p is 'desktop' | 'mobile' => p === 'desktop' || p === 'mobile')),
  };
}

/** Every value that must never reach a report, a log line or a gallery: passwords, keys, tokens and the site's own address. */
export function secretsOf(env: JourneyEnv): string[] {
  const out = [env.password, env.newPassword, env.model?.key ?? '', env.starter?.token ?? '', env.url];
  try {
    out.push(new URL(env.url).host, new URL(env.url).hostname);
  } catch {
    // a malformed address has nothing more to hide
  }
  if (env.model?.baseUrl) out.push(env.model.baseUrl);
  out.push(...env.maskWords);
  return [...new Set(out.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
}

export function scrub(text: string, env: JourneyEnv): string {
  let out = text;
  for (const s of secretsOf(env)) out = out.split(s).join('[hidden]');
  // a 40+ character hex or token-looking run is never useful in a report
  return out.replace(/\bmte_[0-9a-f]{40}\b/g, '[code]').replace(/\b[0-9a-f]{40,}\b/g, '[hex]');
}

// ---- the report --------------------------------------------------------------------------------------------------------------------------------------

export type StepStatus = 'pass' | 'fail' | 'skipped';
export interface StepRecord {
  n: number;
  id: string;
  title: string;
  status: StepStatus;
  seconds: number;
  note?: string;
  reason?: string;
}
export interface AnswerRecord {
  runner: string;
  where: 'channel' | 'dm';
  seconds: number;
}

/** Thrown inside a step to say "not done, and why": the step is recorded as skipped. */
export class Skip extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export const skip = (reason: string): never => {
  throw new Skip(reason);
};

export interface StepApi {
  /** Adds a sentence to the step's note (shown in the report). */
  note(text: string): void;
}

export interface Visit {
  name: string;
  path: string;
  /** Also drawn in the dark look in the phone pass. */
  main: boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');

// ---- masking -----------------------------------------------------------------------------------------------------------------------------------------

/**
 * Puts a solid box over every address and e-mail on the page: e-mails, web addresses, numbers like 10.0.0.1, host names, the enrol command's code, long hashes and
 * the words the caller names. The text stays in the page (React keeps working); only boxes are added, and the returned function takes them away. Values of text
 * fields are covered too. Returns how many boxes were drawn.
 */
export async function maskPage(page: Page, words: readonly string[] = []): Promise<{ boxes: number; remove: () => Promise<void> }> {
  const boxes = await page.evaluate((extra: string[]) => {
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sources = [
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
      'https?://[^\\s"\'<>)]+',
      '\\b\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d+)?\\b',
      '\\b(?:[a-z0-9-]+\\.)+(?:com|net|org|io|to|dev|app|xyz|ai|cloud|example|test|local|internal|lan)\\b(?::\\d+)?',
      '--enrol\\s+\\S+',
      '--ca-sha256\\s+\\S+',
      'sha256//\\S+',
      '\\b[0-9a-f]{40,}\\b',
      esc(location.host),
      ...extra.filter((w) => w.length >= 3).map(esc),
    ];
    const re = new RegExp(sources.join('|'), 'gi');
    const drawn: HTMLElement[] = [];
    const box = (r: DOMRect): void => {
      if (r.width < 1 || r.height < 1) return;
      const d = document.createElement('div');
      d.setAttribute('data-journey-mask', '');
      d.style.cssText = `position:fixed;left:${r.left - 1}px;top:${r.top - 1}px;width:${r.width + 2}px;height:${r.height + 2}px;background:rgb(43,49,56);border-radius:3px;z-index:2147483647;pointer-events:none`;
      document.body.appendChild(d);
      drawn.push(d);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    for (const t of texts) {
      const parent = t.parentElement;
      if (!parent || parent.closest('script,style,noscript,textarea,[data-journey-mask]')) continue;
      const text = t.data;
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m[0] === '') {
          re.lastIndex += 1;
          continue;
        }
        const range = document.createRange();
        range.setStart(t, m.index);
        range.setEnd(t, m.index + m[0].length);
        for (const r of Array.from(range.getClientRects())) box(r);
      }
    }
    for (const el of Array.from(document.querySelectorAll('input,textarea,select'))) {
      const input = el as HTMLInputElement;
      if (input.type === 'password' || input.type === 'hidden' || input.type === 'checkbox' || input.type === 'radio' || input.type === 'file') continue;
      const value = input.tagName === 'SELECT' ? ((input as unknown as HTMLSelectElement).selectedOptions[0]?.text ?? '') : input.value;
      re.lastIndex = 0;
      if (value !== '' && re.test(value)) box(input.getBoundingClientRect());
    }
    return drawn.length;
  }, [...words]);
  return { boxes, remove: async () => void (await page.evaluate(() => document.querySelectorAll('[data-journey-mask]').forEach((d) => d.remove())).catch(() => undefined)) };
}

// ---- the journey -------------------------------------------------------------------------------------------------------------------------------------

export interface ApiAnswer {
  status: number;
  json: any;
}

/** Which step an async call belongs to: a step that ran over its budget is marked dead and its helpers stop calling the site. */
const stepLife = new AsyncLocalStorage<{ dead: boolean }>();

class OverBudget extends Error {}

export class Journey {
  readonly steps: StepRecord[] = [];
  readonly answers: AnswerRecord[] = [];
  readonly visited: Visit[] = [];
  readonly startedAt = new Date().toISOString();
  /** Facts the steps hand to the later ones (a runner's name, a bot, the team's channel). */
  readonly facts = new Map<string, string>();
  private shots = 0;
  private mobileShots = 0;
  private readonly t0 = Date.now();

  constructor(
    readonly env: JourneyEnv,
    public page: Page,
  ) {
    mkdirSync(env.shotsDir, { recursive: true });
  }

  /** What may be printed or written: the secrets and the address are replaced. */
  clean = (text: string): string => scrub(text, this.env);

  log(text: string): void {
    console.log(`[journey] ${this.clean(text)}`);
  }

  // ---- steps ---------------------------------------------------------------------------------------------------------------------------------------

  statusOf(id: string): StepStatus | undefined {
    return this.steps.find((s) => s.id === id)?.status;
  }

  /**
   * Runs one numbered step. A thrown `skip(reason)` is recorded as skipped, any other error as a failure (with a screenshot of the page as it was), and a step that
   * passes the hard budget is a failure too; the journey goes on with the next step either way. `needs` names steps that must have passed first.
   */
  async step(id: string, title: string, fn: (s: StepApi) => Promise<string | void>, opts: { needs?: string[]; budgetS?: number; always?: boolean } = {}): Promise<StepRecord> {
    const rec: StepRecord = { n: this.steps.length + 1, id, title, status: 'skipped', seconds: 0 };
    const started = Date.now();
    const notes: string[] = [];
    const finish = (status: StepStatus, extra: { reason?: string; note?: string } = {}): StepRecord => {
      rec.status = status;
      rec.seconds = Math.round((Date.now() - started) / 100) / 10;
      const note = [...notes, extra.note].filter(Boolean).join('; ');
      if (note) rec.note = this.clean(note);
      if (extra.reason) rec.reason = this.clean(extra.reason);
      this.steps.push(rec);
      this.writeReport();
      this.log(`${pad(rec.n)} ${id}: ${status === 'skipped' ? `skipped: ${rec.reason}` : status}${status === 'fail' ? ` (${rec.reason})` : ''} in ${rec.seconds}s${rec.note ? ` [${rec.note}]` : ''}`);
      return rec;
    };
    // a step the others cannot do without (`always`, the sign-in) runs whatever was selected
    if (!opts.always && this.env.only.size > 0 && !this.env.only.has(id)) return finish('skipped', { reason: 'not selected (JOURNEY_ONLY)' });
    if (!opts.always && this.env.skipIds.has(id)) return finish('skipped', { reason: 'left out (JOURNEY_SKIP)' });
    for (const need of opts.needs ?? []) {
      const s = this.statusOf(need);
      if (s !== 'pass') return finish('skipped', { reason: `needs "${need}", which ${s === undefined ? 'did not run' : s === 'fail' ? 'failed' : 'was skipped'}` });
    }
    const budgetMs = (opts.budgetS ?? 900) * 1000 + 60_000;
    let timer: NodeJS.Timeout | undefined;
    const life = { dead: false };
    try {
      const note = await Promise.race([
        stepLife.run(life, () => fn({ note: (t) => void notes.push(t) })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            life.dead = true; // what the step is still doing no longer reaches the site
            reject(new OverBudget(`the step took longer than its budget of ${Math.round(budgetMs / 1000)} s`));
          }, budgetMs);
        }),
      ]);
      return finish('pass', typeof note === 'string' ? { note } : {});
    } catch (e) {
      if (e instanceof Skip) return finish('skipped', { reason: e.reason });
      const text = e instanceof Error ? e.message : String(e);
      await this.failureShot(id).catch(() => undefined);
      // a step that ran over its budget may still be driving the page: the next step gets a page of its own
      if (e instanceof OverBudget) await this.freshPage().catch(() => undefined);
      return finish('fail', { reason: text.split('\n').slice(0, 6).join(' ').slice(0, 600) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A new page in the same signed-in context; the old one is closed (which also ends whatever a step that ran over its budget was still doing). */
  async freshPage(): Promise<Page> {
    const context = this.page.context();
    const old = this.page;
    this.page = await context.newPage();
    await old.close().catch(() => undefined);
    return this.page;
  }

  summary(): { pass: number; fail: number; skipped: number } {
    const count = (s: StepStatus): number => this.steps.filter((x) => x.status === s).length;
    return { pass: count('pass'), fail: count('fail'), skipped: count('skipped') };
  }

  writeReport(): void {
    const report = {
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      totalSeconds: Math.round((Date.now() - this.t0) / 1000),
      site: '[hidden]',
      summary: this.summary(),
      steps: this.steps,
      answers: this.answers,
      screenshots: { desktop: this.shots, phone: this.mobileShots },
    };
    writeFileSync(join(this.env.shotsDir, 'fresh-install-report.json'), `${this.clean(JSON.stringify(report, null, 2))}\n`);
  }

  // ---- screenshots ---------------------------------------------------------------------------------------------------------------------------------

  private async save(page: Page, file: string, o: { full?: boolean } = {}): Promise<string> {
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page.evaluate(() => document.fonts.ready).catch(() => undefined);
    const masked = this.env.mask ? await maskPage(page, this.env.maskWords) : null;
    try {
      const path = join(this.env.shotsDir, file);
      await page.screenshot({ path, mask: [page.locator('[data-vt-mask]')], maskColor: 'rgb(43, 49, 56)', animations: 'disabled', fullPage: o.full === true });
      return path;
    } finally {
      await masked?.remove();
    }
  }

  private gallery(path: string, file: string, phone: boolean): void {
    if (this.env.gallery === '' || (phone && this.env.gallery === 'desktop')) return;
    mkdirSync(GALLERY_DIR, { recursive: true });
    copyFileSync(path, join(GALLERY_DIR, file));
  }

  /**
   * One numbered screenshot of the desktop pass (1440 by 900). `main` marks the page for the dark look in the phone pass, which replays every page that was shot
   * (`replay: false` leaves one out, for a page that only exists once, such as a dialog).
   */
  async shot(name: string, o: { main?: boolean; replay?: boolean; full?: boolean; page?: Page } = {}): Promise<string> {
    const page = o.page ?? this.page;
    this.shots += 1;
    const file = `${pad(this.shots)}-${name}-1440.png`;
    const path = await this.save(page, file, o.full === undefined ? {} : { full: o.full });
    this.gallery(path, file, false);
    if (o.replay !== false) {
      try {
        const u = new URL(page.url());
        this.visited.push({ name, path: `${u.pathname}${u.search}`, main: o.main === true });
      } catch {
        // a page with no address is not replayed
      }
    }
    return path;
  }

  /** A shot of the phone pass: `m<n>-<name>-390-<light|dark>.png`. */
  async phoneShot(page: Page, name: string, scheme: 'light' | 'dark'): Promise<string> {
    this.mobileShots += 1;
    const file = `m${pad(this.mobileShots)}-${name}-390-${scheme}.png`;
    const path = await this.save(page, file);
    this.gallery(path, file, true);
    return path;
  }

  private async failureShot(id: string): Promise<void> {
    if (this.page.isClosed()) return;
    // never in the gallery: a failure picture is for the person running the journey
    await this.save(this.page, `fail-${id}.png`);
  }

  // ---- the site's own API, as the signed-in person -------------------------------------------------------------------------------------------------

  async api(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<ApiAnswer> {
    if (stepLife.getStore()?.dead) throw new OverBudget('the step ran over its budget and was left');
    const jar = await this.page.context().cookies();
    const csrf = jar.find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
    const res = await this.page.request.fetch(path, {
      method,
      ...(data === undefined && method === 'GET' ? {} : { data: data ?? {} }),
      headers: csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {},
      failOnStatusCode: false,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    return { status: res.status(), json };
  }

  /** A route that must answer with a success status; the failure names the path and the status, never the body (it may hold a value). */
  async must(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<any> {
    const r = await this.api(method, path, data);
    if (r.status >= 300) throw new Error(`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} answered ${r.status}${typeof r.json?.error === 'string' ? ` (${r.json.error})` : r.json?.message ? ` (${String(r.json.message).slice(0, 160)})` : ''}`);
    return r.json;
  }
}

// ---- signing in --------------------------------------------------------------------------------------------------------------------------------------

async function tryPassword(page: Page, email: string, password: string): Promise<'in' | 'refused'> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const outcome = await Promise.race([
    page.waitForURL((u) => !/\/sign-in/.test(u.pathname), { timeout: 30_000 }).then(() => 'in' as const),
    page.getByRole('alert').first().waitFor({ timeout: 30_000 }).then(() => 'refused' as const),
  ]).catch(() => 'refused' as const);
  return outcome;
}

/**
 * The first sign-in of an install: the page for the password the installer printed, then the page that asks the person to choose their own. Runs again after the
 * password was changed (the new password then signs in at once). Returns what happened, for the report.
 */
export async function signInAndChoosePassword(j: Journey): Promise<string> {
  const { page, env } = j;
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await j.shot('sign-in', { replay: false });
  let first = await tryPassword(page, env.email, env.password);
  let note = '';
  if (first === 'refused') {
    // the first password was already replaced (the journey ran before): the new one has to work
    if ((await tryPassword(page, env.email, env.newPassword)) === 'refused') throw new Error('Neither the installer password nor the new password signs in.');
    first = 'in';
    note = 'the password was already changed; signed in with the new one';
  } else {
    const form = page.getByTestId('first-password-form');
    if (await form.isVisible().catch(() => false)) {
      await expect(page.getByRole('heading', { name: 'Choose your own password' })).toBeVisible();
      const fields = form.locator('input');
      await fields.nth(0).fill(env.password);
      await fields.nth(1).fill(env.newPassword);
      await j.shot('choose-new-password', { replay: false });
      await form.getByRole('button', { name: 'Set my password' }).click();
      await expect(form).toHaveCount(0, { timeout: 30_000 });
      note = 'chose a new password at the first sign-in';
    } else {
      note = 'the installer password did not ask for a new one (already chosen?)';
    }
  }
  // the session may have been closed by the change (other sessions are signed out): sign in again with the new password when that is so
  await page.goto('/');
  if (/\/sign-in/.test(page.url())) {
    if ((await tryPassword(page, env.email, env.newPassword)) === 'refused') throw new Error('The new password does not sign in.');
  }
  await expect(page.getByTestId('app-frame')).toBeVisible({ timeout: 30_000 });
  await j.shot('signed-in', { main: true });
  return note;
}

// ---- the wizard --------------------------------------------------------------------------------------------------------------------------------------

export const stepLoc = (page: Page, id: string): Locator => page.locator(`[data-landmark="steps"] [data-step="${id}"]`);

/** Opens `/onboarding?step=<id>` and waits until that step is the open one. */
export async function openStep(j: Journey, id: string): Promise<Locator> {
  const step = stepLoc(j.page, id);
  // the site may be restarting for a moment (a team made, a setting saved): a page that says it cannot reach the site is tried again, a few times
  for (let attempt = 1; ; attempt += 1) {
    try {
      await j.page.goto(`/onboarding?step=${id}`);
      await expect(step).toHaveAttribute('data-open', 'true', { timeout: 30_000 });
      return step;
    } catch (e) {
      if (attempt >= 4) throw e;
      j.log(`the wizard step ${id} did not open (try ${attempt}); trying again in 15 s`);
      await j.page.waitForTimeout(15_000);
    }
  }
}

/** Scrolls a step to the top of the window so its whole panel is in the shot. */
export async function showStep(step: Locator): Promise<void> {
  await step.evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => undefined);
  await step.page().waitForTimeout(300);
}

export const isDone = async (step: Locator): Promise<boolean> => (await step.getAttribute('data-done')) === 'true';

export async function wizardFirstView(j: Journey): Promise<string> {
  await j.page.goto('/onboarding');
  await expect(j.page.getByRole('heading', { name: 'Finish setting up', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(j.page.locator('[data-landmark="steps"] [data-step]')).toHaveCount(13, { timeout: 30_000 });
  const count = 13;
  await expect(stepLoc(j.page, 'bootstrap')).toHaveAttribute('data-done', 'true');
  await j.shot('wizard-first-view', { main: true });
  return `${count} steps`;
}

export async function stepTheme(j: Journey): Promise<string> {
  const step = await openStep(j, 'theme');
  const page = j.page;
  await page.getByTestId('ob-theme-palette-harbor').click();
  await expect(step).toHaveAttribute('data-done', 'true');
  await showStep(step);
  await j.shot('wizard-theme-harbor');
  await page.getByTestId('ob-theme-palette-classic').click();
  // the person keeps Classic: a decision the wizard records
  const keep = page.getByTestId('ob-theme-keep');
  if (await keep.isVisible().catch(() => false)) await keep.click();
  await expect(step).toHaveAttribute('data-done', 'true');
  await showStep(step);
  await j.shot('wizard-theme-kept');
  return 'tried Harbor, kept Classic';
}

export async function stepOrganization(j: Journey): Promise<string> {
  const step = await openStep(j, 'organization');
  if (await isDone(step)) {
    await showStep(step);
    await j.shot('wizard-organization-done');
    return 'already named';
  }
  await j.page.getByTestId('ob-org-name').fill(j.env.org);
  await showStep(step);
  await j.shot('wizard-organization-form');
  await j.page.getByTestId('ob-org-save').click();
  await expect(step).toHaveAttribute('data-done', 'true', { timeout: 30_000 });
  await showStep(step);
  await j.shot('wizard-organization-saved');
  const ws = await j.must('GET', '/api/workspace');
  expect(ws.workspace.name).toBe(j.env.org);
  return 'named the organization';
}

export async function stepInfrastructure(j: Journey): Promise<string> {
  const step = await openStep(j, 'infrastructure');
  await expect(step.getByTestId('ob-https-facts')).toBeVisible();
  await showStep(step);
  await j.shot('wizard-infrastructure');
  const done = await isDone(step);
  return done ? 'served over HTTPS' : 'plain HTTP: the step shows the address and the command to move to a domain (optional, left as it is)';
}

export async function stepModels(j: Journey): Promise<string> {
  const model = j.env.model;
  const step = await openStep(j, 'models');
  if (await isDone(step)) {
    await showStep(step);
    await j.shot('wizard-models-done');
    return 'smart already answered a test';
  }
  if (!model) return skip('no model key given (JOURNEY_MODEL_KEY, or JOURNEY_MODEL_KEY_ENV naming the variable that holds it)');
  const page = j.page;
  // the provider may already be bound from an earlier run: then only the test is left
  if (await page.getByTestId('ob-models-form').isVisible().catch(() => false)) {
    await page.getByTestId(`ob-preset-${model.preset}`).click();
    const base = page.getByTestId('ob-model-base');
    if (await base.isVisible().catch(() => false)) {
      if (model.baseUrl === '') return skip('this model choice needs an address (JOURNEY_MODEL_BASE_URL)');
      await base.fill(model.baseUrl);
    }
    const name = page.getByTestId('ob-model-name');
    if (await name.isVisible().catch(() => false)) {
      if (model.name === '') return skip('this model choice needs the model name (JOURNEY_MODEL_NAME)');
      await name.fill(model.name);
    }
    await page.getByTestId('ob-model-key').fill(model.key);
    await showStep(step);
    await j.shot('wizard-models-form');
    await page.getByTestId('ob-model-connect').click();
    await expect(page.getByTestId('ob-models-form')).toHaveCount(0, { timeout: 60_000 });
  }
  // a save is not tested for a few seconds (the model proxy may still hold the old settings)
  await page.waitForTimeout(12_000);
  await expect(step.locator('[data-alias]').first()).toBeVisible({ timeout: 30_000 });
  const aliases = await step.locator('[data-alias]').evaluateAll((els) => els.map((e) => e.getAttribute('data-alias') ?? ''));
  for (const alias of aliases) {
    const row = step.locator(`[data-alias="${alias}"]`);
    await row.getByRole('button', { name: `Test the ${alias} alias`, exact: true }).click();
    const state = row.locator('[data-test-state]');
    await expect(state).toHaveAttribute('data-test-state', /ok|failed/, { timeout: 180_000 });
    if ((await state.getAttribute('data-test-state')) !== 'ok') {
      await showStep(step);
      await j.shot(`wizard-models-${alias}-failed`);
      throw new Error(`the ${alias} alias did not answer its test (${(await state.getAttribute('data-cause')) ?? 'no cause named'})`);
    }
  }
  await expect(step).toHaveAttribute('data-done', 'true');
  await showStep(step);
  await j.shot('wizard-models-tested', { main: true });
  return 'smart, fast and code answered';
}

export async function stepSignin(j: Journey): Promise<string> {
  const step = await openStep(j, 'signin');
  if (await isDone(step)) {
    await showStep(step);
    await j.shot('wizard-signin-done');
    return 'already decided';
  }
  await showStep(step);
  await j.shot('wizard-signin');
  await j.page.getByTestId('ob-signin-password').click();
  await expect(step).toHaveAttribute('data-done', 'true');
  await showStep(step);
  await j.shot('wizard-signin-passwords-only');
  return 'passwords only';
}

export async function stepTeams(j: Journey): Promise<string> {
  const step = await openStep(j, 'teams');
  await expect(step.locator('[data-template]').first()).toBeVisible({ timeout: 30_000 });
  const templates = await step.locator('[data-template]').count();
  expect(templates).toBeGreaterThanOrEqual(5);
  const make = step.getByTestId('ob-teams-make');
  await showStep(step);
  await j.shot('wizard-teams-offer');
  if (await make.isEnabled()) {
    await make.click();
    await expect(make).toHaveText('Nothing left to make', { timeout: 420_000 });
  }
  await expect(step).toHaveAttribute('data-done', 'true');
  await expect(step.getByTestId('ob-template-engineering')).toBeChecked();
  await showStep(step);
  await j.shot('wizard-teams-made', { main: true });
  return `${templates} templates, all made`;
}

// ---- servers: this machine enrolled through the wizard --------------------------------------------------------------------------------------------------

/** Runs the command the wizard shows through the helper the coordinator gave, and answers the helper's exit code. The command is passed in the environment, never printed. */
export async function runEnrolHelper(helper: string, command: string, logFile: string, timeoutS = 900): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', helper], { env: { ...process.env, JOURNEY_ENROLL_COMMAND: command }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (c: Buffer): void => {
      if (out.length < 200_000) out += c.toString('utf8');
    };
    const clock = setTimeout(() => child.kill('SIGKILL'), timeoutS * 1000);
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', () => {
      clearTimeout(clock);
      resolve(127);
    });
    child.on('close', (code) => {
      clearTimeout(clock);
      // the helper's output may name the site and the machine: it stays in a file next to the shots, never on the console and never in the gallery
      writeFileSync(logFile, out);
      resolve(code ?? 1);
    });
  });
}

/** The command the wizard shows (the same words as `installCommand` in the web client; kept here so the journey does not import the web client). */
export function enrolCommand(site: string, code: string, cert: { sha256: string; spkiSha256: string } | null): string {
  const curl = cert ? `curl -fsSLk --pinnedpubkey 'sha256//${cert.spkiSha256}'` : 'curl -fsSL';
  return `${curl} ${site}/install/bridge.sh | sudo bash -s -- --enrol ${code}${cert ? ` --ca-sha256 ${cert.sha256}` : ''}`;
}

export async function stepServers(j: Journey): Promise<string> {
  const { env, page } = j;
  const step = await openStep(j, 'servers');
  if (await isDone(step)) {
    await showStep(step);
    await j.shot('wizard-servers-connected');
    return 'a server is already connected';
  }
  if (env.noServer) return skip(env.noServer);
  const label = env.serverLabel;
  let command = '';
  const nameField = page.getByTestId('ob-server-name');
  if (await nameField.isVisible().catch(() => false)) {
    await nameField.fill(label);
    await showStep(step);
    await j.shot('wizard-servers-name');
    await page.getByTestId('ob-server-make').click();
    const shown = page.getByTestId('ob-server-command-text');
    const refused = page.getByRole('alert').first();
    await Promise.race([shown.waitFor({ timeout: 30_000 }), refused.waitFor({ timeout: 30_000 })]).catch(() => undefined);
    if (await shown.isVisible().catch(() => false)) command = ((await shown.textContent()) ?? '').trim();
  }
  if (command === '') {
    // the machine's name is taken (an earlier run made it): ask for a fresh code for it instead
    const list = await j.must('GET', '/api/admin/bot-servers');
    const mine = (list.items as any[]).find((s) => s.label === label);
    if (!mine) throw new Error('The wizard did not show a command and no server of that name exists.');
    const code = await j.must('POST', `/api/admin/bot-servers/${mine.id}/code`);
    command = enrolCommand(env.url, code.code, code.install?.siteCert ?? null);
  }
  await showStep(step);
  await j.shot('wizard-servers-command');
  // the command holds a one-use code: it goes to a file only when a person has to run it (never readable by others, never left from an earlier run)
  const file = join(tmpdir(), `journey-enrol-${process.pid}.txt`);
  const keep = (text: string): void => {
    rmSync(file, { force: true });
    writeFileSync(file, `${text}\n`, { mode: 0o600, flag: 'wx' });
  };
  if (!env.enrollRunner) keep(command);
  let how: string;
  if (env.enrollRunner) {
    const code = await runEnrolHelper(env.enrollRunner, command, join(env.shotsDir, 'enrol-helper-output.log'), env.enrollWaitS);
    how = `the enrol helper ended with exit code ${code}`;
    if (code !== 0) j.log(`the enrol helper exited with ${code}; waiting to see whether the server connects anyway`);
  } else {
    how = 'waited for a person to run the command';
    j.log(`ENROL: run the command in ${file} (mode 0600, one use, 15 minutes) on the machine to enrol; waiting up to ${env.enrollWaitS} s for it to connect`);
  }
  // the wizard looks for the machine by itself every few seconds; the code lasts 15 minutes, so a longer wait asks for a fresh one
  const until = Date.now() + env.enrollWaitS * 1000;
  let minted = Date.now();
  while (Date.now() < until) {
    if (await isDone(step)) break;
    if (!env.enrollRunner && Date.now() - minted > 13 * 60_000) {
      const list = await j.must('GET', '/api/admin/bot-servers');
      const mine = (list.items as any[]).find((s) => s.label === label);
      if (mine) {
        const code = await j.must('POST', `/api/admin/bot-servers/${mine.id}/code`);
        keep(enrolCommand(env.url, code.code, code.install?.siteCert ?? null));
        j.log(`ENROL: the code ran out; a fresh command is in ${file}`);
        minted = Date.now();
      }
    }
    await page.waitForTimeout(5_000);
  }
  if (!(await isDone(step))) {
    return skip(`no server connected within ${env.enrollWaitS} s (${how})${env.enrollRunner ? '' : `; the command is in ${file} on the machine that runs the journey`}`);
  }
  await showStep(step);
  await j.shot('wizard-servers-connected', { main: true });
  return how;
}

// ---- runners ------------------------------------------------------------------------------------------------------------------------------------------

export async function listRunners(j: Journey): Promise<any[]> {
  return (await j.must('GET', '/api/admin/bot-runners')).items as any[];
}

/** Waits until a runner reaches the state `ready` (a pod starts, a sign-in is read), within `seconds`. */
export async function waitRunnerReady(j: Journey, pick: (r: any) => boolean, seconds: number): Promise<any> {
  const until = Date.now() + seconds * 1000;
  let last: any;
  while (Date.now() < until) {
    last = (await listRunners(j)).find(pick);
    if (last?.status === 'ready' && last.enabled) return last;
    await j.page.waitForTimeout(8_000);
  }
  throw new Error(`the runner did not become ready in ${seconds} s (${last ? `${last.status}${last.statusDetail ? `: ${String(last.statusDetail).slice(0, 160)}` : ''}` : 'it does not exist'})`);
}

/** The Hermes pod runner of the wizard's Runners step: deploy it and ask a real question, then wait until the step is done. */
export async function stepRunnersPod(j: Journey): Promise<string> {
  const { page, env } = j;
  const step = await openStep(j, 'runners');
  if (await isDone(step)) {
    await showStep(step);
    await j.shot('wizard-runners-done');
    return 'a runner already answered a real question';
  }
  const deploy = page.getByTestId('ob-runner-deploy');
  if (!(await deploy.isVisible().catch(() => false))) await page.getByTestId('ob-runner-offer-open').click();
  await showStep(step);
  await j.shot('wizard-runners-offer');
  await expect(deploy).toBeEnabled({ timeout: 30_000 });
  await deploy.click();
  const until = Date.now() + env.podWaitS * 1000;
  let shotMid = false;
  let tries = 1;
  while (Date.now() < until) {
    if (await isDone(step)) break;
    if (!shotMid && (await page.getByTestId('ob-runner-stage').isVisible().catch(() => false))) {
      shotMid = true;
      await showStep(step);
      await j.shot('wizard-runners-asking', { replay: false });
    }
    // a failure shows in one sentence with a retry: the pod may still be starting, so ask again a little later
    if (await step.getByRole('alert').first().isVisible().catch(() => false)) {
      const retry = page.getByTestId('ob-runner-prove-hermes');
      await page.waitForTimeout(30_000);
      if (await retry.isEnabled().catch(() => false)) {
        tries += 1;
        await retry.click();
      }
    }
    await page.waitForTimeout(4_000);
  }
  if (!(await isDone(step))) throw new Error(`the Hermes pod did not answer a real question within ${env.podWaitS} s (${tries} tries)`);
  await showStep(step);
  await j.shot('wizard-runners-proven', { main: true });
  return `the pod answered after ${tries} ${tries === 1 ? 'try' : 'tries'}`;
}

/** Sets up the Claude Code or Codex runner from the wizard's Runners step (it makes the runner and opens its sign-in), then closes the dialog. */
export async function setUpPodAgent(j: Journey, kind: 'claude_cli' | 'codex_cli'): Promise<string> {
  const step = await openStep(j, 'runners');
  const existing = (await listRunners(j)).find((r) => r.kind === kind);
  if (existing) {
    j.facts.set(kind, existing.name);
    await showStep(step);
    await j.shot(`wizard-runners-${kind === 'claude_cli' ? 'claude' : 'codex'}-present`);
    return `the runner ${existing.name} already exists`;
  }
  const card = step.getByTestId(`ob-sub-${kind}`);
  // the card draws after the runner list has loaded
  await card.waitFor({ timeout: 30_000 }).catch(() => undefined);
  if (!(await card.isVisible().catch(() => false))) return skip('this site does not run Claude Code and Codex pods (the wizard does not offer them)');
  await card.getByTestId(`ob-sub-signin-${kind}`).click();
  const dialog = j.page.getByTestId('runner-agent-signin-dialog');
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await j.shot(`wizard-runners-${kind === 'claude_cli' ? 'claude' : 'codex'}-signin`, { replay: false });
  await dialog.getByRole('button', { name: 'Close' }).click();
  const made = (await listRunners(j)).find((r) => r.kind === kind);
  if (!made) throw new Error('the wizard did not make the runner');
  j.facts.set(kind, made.name);
  await showStep(step);
  await j.shot(`wizard-runners-${kind === 'claude_cli' ? 'claude' : 'codex'}-made`, { main: false });
  return `made the runner ${made.name}`;
}

/** Uploads a sign-in file through the Runners page's own form. The file's path is handed to the browser; its text never passes through this script. */
export async function uploadSignin(j: Journey, kind: 'claude_cli' | 'codex_cli', file: string): Promise<string> {
  const { page } = j;
  const runner = (await listRunners(j)).find((r) => r.kind === kind);
  if (!runner) return skip('the runner does not exist');
  const which = kind === 'claude_cli' ? 'claude' : 'codex';
  await page.goto('/settings/workspace/runners');
  const row = page.locator(`[data-testid="runner-row"][data-runner="${runner.name}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  if (runner.uploadedAt) {
    await row.scrollIntoViewIfNeeded();
    await j.shot(`runners-${which}-has-file`);
    return 'a sign-in file is already uploaded';
  }
  // a pod runner with no file offers the page's own sign-in first; the file is one button inside it
  const direct = row.getByTestId('runner-signin-open');
  if ((await direct.count()) > 0) await direct.click();
  else {
    await row.getByTestId('runner-agent-signin-open').click();
    await page.getByTestId('agent-auth-use-file').click();
  }
  const dialog = page.getByTestId('runner-signin-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByTestId('runner-signin-file').setInputFiles(file);
  const preview = dialog.getByTestId('runner-signin-preview');
  const bad = dialog.getByTestId('runner-signin-invalid');
  await Promise.race([preview.waitFor({ timeout: 30_000 }), bad.waitFor({ timeout: 30_000 })]).catch(() => undefined);
  if (await bad.isVisible().catch(() => false)) throw new Error(`the page did not accept the file: ${((await bad.textContent()) ?? '').slice(0, 200)}`);
  await expect(preview).toBeVisible();
  await dialog.getByTestId('runner-signin-terms').check();
  const others = dialog.getByTestId('runner-signin-others');
  if (await others.isVisible().catch(() => false)) await others.check();
  await j.shot(`runners-${which}-upload`, { replay: false });
  await expect(dialog.getByTestId('runner-signin-upload')).toBeEnabled();
  await dialog.getByTestId('runner-signin-upload').click();
  const failed = dialog.getByTestId('runner-form-error');
  const outcome = await Promise.race([
    dialog.waitFor({ state: 'detached', timeout: 20_000 }).then(() => 'closed' as const),
    failed.waitFor({ timeout: 20_000 }).then(() => 'refused' as const),
  ]).catch(() => 'open' as const);
  if (outcome === 'refused') throw new Error(`the upload was refused: ${((await failed.textContent()) ?? '').slice(0, 200)}`);
  // a dialog that stays open after a good upload is closed as a person would
  if (outcome === 'open' && (await dialog.isVisible().catch(() => false))) await dialog.getByRole('button', { name: 'Close' }).click();
  return 'uploaded through the Runners page';
}

// ---- bots on runners: one bot per runner, then the questions ----------------------------------------------------------------------------------------

export interface BotPlan {
  slug: string;
  wish: RunnerWish;
  runner: string;
  /** The tool the bot may use on the runner: the coding agents need a shell. */
  coding: boolean;
}

export const botDefinition = (p: BotPlan): string =>
  [
    '---',
    'schema: 1',
    `name: ${p.slug}`,
    `role: Answers the journey's questions on the ${p.wish} runner.`,
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    '  - { type: conversation }',
    '  - { type: mention }',
    'conversation:',
    '  prompts:',
    '    - "Say hello and name the model you are."',
    'capabilities:',
    '  native: [messages.post, memory.recall, memory.retain]',
    ...(p.coding ? ['  runtime: [shell, files, git]'] : []),
    'placement:',
    `  runs_on: ${p.runner}`,
    '---',
    '',
    `# ${p.slug}`,
    '',
    'You answer short questions from the people who test a new install. Answer in one or two plain sentences. When you are told to remember something, save it with your',
    'memory tool and say so; when you are asked what you were told, look it up with your memory tool before you answer.',
    '',
  ].join('\n');

/** Adds the bot (or changes its placement) through a proposal applied at once, as an admin does; answers once the loader has made it. */
export async function placeBot(j: Journey, p: BotPlan): Promise<string> {
  const team = j.env.team;
  const path = `bots/${p.slug}/BOT.md`;
  const current = await j.api('GET', `/api/teams/${team}/repo/blob?path=${encodeURIComponent(path)}`);
  const content = botDefinition(p);
  let changed = 'added';
  if (current.status === 200) {
    if (current.json.content === content) changed = 'already placed';
    else {
      await j.must('POST', `/api/teams/${team}/proposals`, { path, op: 'put', content, baseBlobSha: current.json.blobSha, title: `Journey: place ${p.slug} on ${p.runner}`, applyNow: true });
      changed = 'moved';
    }
  } else {
    await j.must('POST', `/api/teams/${team}/proposals`, { path, op: 'put', content, title: `Journey: add ${p.slug} on ${p.runner}`, applyNow: true });
  }
  const until = Date.now() + 120_000;
  for (;;) {
    const list = await j.api('GET', `/api/teams/${team}/bots`);
    const bot = (list.json?.bots as any[] | undefined)?.find((b) => b.name === p.slug || b.slug === p.slug);
    if (bot && bot.invalid === null && bot.mentionable) break;
    if (Date.now() > until) throw new Error(`the loader did not make ${p.slug}${bot?.invalid ? `: ${String(bot.invalid.message).slice(0, 200)}` : ''}`);
    await j.page.waitForTimeout(3_000);
  }
  return changed;
}

export async function channelIdOf(j: Journey, name: string): Promise<string> {
  const dir = await j.must('GET', `/api/teams/${j.env.team}/channels`);
  const all = (dir.groups as any[]).flatMap((g) => g.channels as any[]);
  const c = all.find((x) => String(x.name).replace(/^#/, '') === name);
  if (!c) throw new Error(`the team has no #${name} channel`);
  return c.id as string;
}

export interface Asked {
  rootId: string;
  channelId: string;
  answer: string;
  seconds: number;
}

/**
 * Posts a message, then waits for the bot's answer in its thread and times it. The answer is the bot's last reply once its runs have ended (or a short settle after
 * the first reply). Fails with what the thread holds when nothing arrives in time.
 */
export async function ask(j: Journey, o: { channelId: string; text: string; runner: string; where: 'channel' | 'dm'; timeoutS?: number }): Promise<Asked> {
  const t0 = Date.now();
  const posted = await j.must('POST', `/api/channels/${o.channelId}/messages`, { channelId: o.channelId, body: o.text, threadRootId: null });
  const rootId = posted.id as string;
  const limit = Date.now() + (o.timeoutS ?? j.env.answerTimeoutS) * 1000;
  let firstAt = 0;
  let answer = '';
  let seen: string[] = [];
  for (;;) {
    const t = await j.api('GET', `/api/threads/${rootId}?limit=50`);
    const replies = ((t.json?.replies?.items ?? []) as any[]).slice().reverse();
    const bots = replies.filter((m) => m.author?.kind === 'bot' && String(m.body ?? '').trim() !== '');
    seen = replies.filter((m) => m.author?.kind !== 'person').map((m) => `${m.author?.kind}: ${String(m.body ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
    if (bots.length > 0) {
      firstAt = firstAt || Date.now();
      answer = String(bots[bots.length - 1].body);
      const runs = await j.api('GET', `/api/threads/${rootId}/runs`);
      const going = ((runs.json?.runs ?? []) as any[]).some((r) => r.endedAt === null || r.endedAt === undefined);
      if (!going || Date.now() - firstAt > 45_000) break;
    }
    if (Date.now() > limit) {
      const runs = await j.api('GET', `/api/threads/${rootId}/runs`);
      const states = ((runs.json?.runs ?? []) as any[]).map((r) => String(r.state)).join(', ');
      throw new Error(`no answer from ${o.runner} within ${o.timeoutS ?? j.env.answerTimeoutS} s (run states: ${states || 'no run'}; thread: ${seen.join(' | ') || 'empty'})`);
    }
    await j.page.waitForTimeout(3_000);
  }
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  j.answers.push({ runner: o.runner, where: o.where, seconds });
  return { rootId, channelId: o.channelId, answer, seconds };
}

/**
 * A bot that was only just placed cannot answer at once: its runner needs the profile first, and until then every run ends with a fixed "I couldn't answer" notice.
 * This asks a throwaway question again and again until a real answer comes (or the time is up) and says how long that took, so the questions that count are not lost to it.
 */
export async function warmUp(j: Journey, o: { slug: string; runner: string; timeoutS: number }): Promise<{ seconds: number; tries: number; last: string }> {
  const t0 = Date.now();
  const channelId = await channelIdOf(j, 'dev');
  let tries = 0;
  let last = '';
  while (Date.now() - t0 < o.timeoutS * 1000) {
    tries += 1;
    const posted = await j.must('POST', `/api/channels/${channelId}/messages`, { channelId, body: `@${o.slug} Reply with the single word ready.`, threadRootId: null });
    const until = Date.now() + 90_000;
    for (;;) {
      await j.page.waitForTimeout(3_000);
      const t = await j.api('GET', `/api/threads/${posted.id}?limit=20`);
      const bot = ((t.json?.replies?.items ?? []) as any[]).find((m) => m.author?.kind === 'bot' && String(m.body ?? '').trim() !== '');
      if (bot) {
        last = String(bot.body).replace(/\s+/g, ' ').slice(0, 140);
        if (!/^i couldn.?t answer/i.test(last)) return { seconds: Math.round((Date.now() - t0) / 1000), tries, last };
        break;
      }
      if (Date.now() > until) {
        last = 'no reply within 90 s';
        break;
      }
    }
    await j.page.waitForTimeout(10_000);
  }
  throw new Error(`${o.runner} did not answer ${o.slug} within ${o.timeoutS} s (${tries} tries; the last thing it said: ${last})`);
}

/** Opens the bot's conversation channel (made on first use). */
export async function dmChannel(j: Journey, botSlug: string): Promise<string> {
  const opened = await j.must('POST', `/api/teams/${j.env.team}/bots/${botSlug}/conversation`, {});
  return opened.channelId as string;
}

/** Opens the thread in the browser as a person would read it, and shoots it. */
export async function showThread(j: Journey, o: { where: 'channel' | 'dm'; bot: string; rootId: string; channel: string; name: string; expect: string }): Promise<void> {
  const page = j.page;
  if (o.where === 'dm') {
    await page.goto(`/t/${j.env.team}/chat?bot=${o.bot}&c=${o.rootId}`);
  } else {
    await page.goto(`/t/${j.env.team}/c/${o.channel}?message=${o.rootId}`);
    const own = page.locator(`[data-message-id="${o.rootId}"]`).getByText(/\d+ repl(y|ies)/);
    await own.first().click({ timeout: 20_000 }).catch(() => undefined);
  }
  const snippet = o.expect.replace(/\s+/g, ' ').trim().slice(0, 30);
  if (snippet !== '') await page.getByText(snippet, { exact: false }).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  await j.shot(o.name, { replay: false });
}

/** A short random tag for one run, so an answer from an earlier run cannot pass for this one. */
export const tag = (): string => Math.random().toString(36).slice(2, 8).toUpperCase();
