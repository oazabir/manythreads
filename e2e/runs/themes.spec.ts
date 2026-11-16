import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiOn, channelsOf, noSidewaysScroll, openOn, PHONE, postAs, type StackApi } from '../support/stack-browser.ts';
import { ORCHESTRATE } from './scripts.ts';
import { startRunsWorld, type RunsWorld } from './support.ts';

/*
 * P28-07: the thread of the run card and the to-do card in every theme (Graphite, Linen, Harbor, and the original Classic), each light and dark, at 1440 px and at 390 px.
 * The look is set the way a person sets it (PUT /api/me/appearance, the call of Settings → Appearance) and read back from the page after a reload, so the stored choice, the
 * early script and the stylesheets are all in the picture. Screenshots go to temp/screenshots/themes (git-ignored). The spec fails when a card text sits on a colour it cannot
 * be read on (WCAG 4.5:1 for the words of the run card and the to-do card), whatever the theme.
 *
 *   flock /tmp/manythreads-test.lock pnpm -C e2e exec playwright test -c <a config with testMatch 'runs/themes.spec.ts'> --workers=1 --retries=0
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);
test.skip(({ isMobile }) => isMobile, 'the phone views are taken inside the test');

const SHOTS = process.env['MANYTHREADS_THEME_SHOTS'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots', 'themes');
const PALETTES = ['graphite', 'linen', 'harbor', 'classic'] as const;
const MODES = ['light', 'dark'] as const;
/** The faces each theme draws with: the text face, and the title face that is the sidebar's workspace name (Linen's is a serif). */
const FACES: Record<(typeof PALETTES)[number], { text: string; title: string }> = {
  graphite: { text: 'Inter', title: 'Inter' },
  linen: { text: 'IBM Plex Sans', title: 'Source Serif 4' },
  harbor: { text: 'Geist', title: 'Geist' },
  classic: { text: 'Inter', title: 'Inter' },
};

let world: RunsWorld;
let dev = '';

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  world = await startRunsWorld();
});
test.afterAll(async () => {
  await world?.close();
});

async function picturesLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll('img')].every((i) => i.complete), undefined, { timeout: 10_000 }).catch(() => undefined);
}

/** The smallest contrast ratio among the words inside `selector`, each against the first opaque colour behind it. */
async function worstContrast(page: Page, selector: string): Promise<{ ratio: number; text: string; fg: string; bg: string }> {
  return page.evaluate((sel) => {
    const parse = (c: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return [0, 0, 0, 0];
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
    };
    const lum = ([r, g, b]: number[]): number => {
      const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const behind = (el: Element): [number, number, number] => {
      let acc: [number, number, number] | null = null;
      const layers: Array<[number, number, number, number]> = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] === 1) break;
      }
      acc = [255, 255, 255];
      for (const [r, g, b, a] of layers.reverse()) acc = [r * a + acc[0] * (1 - a), g * a + acc[1] * (1 - a), b * a + acc[2] * (1 - a)];
      return acc;
    };
    let worst = { ratio: 99, text: '', fg: '', bg: '' };
    for (const root of document.querySelectorAll(sel)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = (n.textContent ?? '').trim();
        const el = n.parentElement;
        if (!text || !el) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || el.getBoundingClientRect().width === 0) continue;
        const fgc = parse(st.color);
        const bg = behind(el);
        const fg: [number, number, number] = [fgc[0] * fgc[3] + bg[0] * (1 - fgc[3]), fgc[1] * fgc[3] + bg[1] * (1 - fgc[3]), fgc[2] * fgc[3] + bg[2] * (1 - fgc[3])];
        const [hi, lo] = [Math.max(lum(fg), lum(bg)), Math.min(lum(fg), lum(bg))];
        const ratio = (hi + 0.05) / (lo + 0.05);
        if (ratio < worst.ratio) worst = { ratio, text: text.slice(0, 40), fg: st.color, bg: `rgb(${bg.map(Math.round).join(', ')})` };
      }
    }
    return worst;
  }, selector);
}

async function setLook(api: StackApi, palette: string, theme: string): Promise<void> {
  const res = await api.ctx.put('/api/me/appearance', { data: { palette, theme }, headers: await api.headers() });
  expect(res.status(), await res.text()).toBe(200);
}

test('the run card and the to-do card read well in every theme, light and dark, at 1440 px and at 390 px', async ({ browser, playwright }) => {
  world.script(ORCHESTRATE);
  const lead = await world.bot('run-lead');
  const helper = await world.bot('run-helper');
  const api = await apiOn(playwright, world.stack, 'nadia');
  const omar = await apiOn(playwright, world.stack, 'omar');
  try {
    dev = (await channelsOf(api))['dev'] ?? '';
    expect(dev, 'the dev channel').not.toBe('');
    const root = await postAs(api, dev, '@run-lead build the run card and test it');
    const path = `/t/engineering/c/dev?panel=thread:${root.id}`;
    const first = await openOn(browser, playwright, world.stack, 'nadia', path);
    await expect(first.page.getByTestId('run-card')).toBeVisible({ timeout: 90_000 });
    await first.context.close();

    // a card for the helper, one done by a person, one waiting
    const made = await api.post<{ task: { id: string } }>('/api/teams/engineering/tasks', { title: 'Build the run card', branch: `e2e/theme-card-${Date.now()}` });
    const notes = await api.post<{ task: { id: string } }>('/api/teams/engineering/tasks', { title: 'Write the notes', branch: `e2e/theme-notes-${Date.now()}` });
    const minted = await omar.post<{ token: string }>('/api/teams/engineering/bots/run-lead/pairing-tokens', {});
    const call = await fetch(`${world.stack.origin}/api/mcp/bots/${lead.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${minted.token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'tasks.todo',
          arguments: {
            action: 'set',
            title: 'Run card',
            items: [
              { id: 'plan', text: 'Plan the parts', status: 'done' },
              { id: 'build', text: 'Build the run card', status: 'waiting', taskId: made.task.id },
              { id: 'docs', text: 'Write the notes', status: 'waiting', taskId: notes.task.id },
              { id: 'ship', text: 'Tell the team', status: 'waiting' },
            ],
          },
        },
      }),
    });
    expect(JSON.stringify(await call.json())).not.toContain('"isError":true');
    await api.post(`/api/teams/engineering/tasks/${made.task.id}/claim`, {});
    await api.post(`/api/teams/engineering/tasks/${made.task.id}/handoff`, { toActorId: helper.actorId, mode: 'bot', note: 'build it' });
    await api.post(`/api/teams/engineering/tasks/${notes.task.id}/claim`, {});
    await api.post(`/api/teams/engineering/tasks/${notes.task.id}/complete`, { testedSha: 'abcdef1' });

    for (const palette of PALETTES) {
      for (const mode of MODES) {
        await setLook(api, palette, mode);
        const name = `${palette}.${mode}`;
        for (const phone of [false, true]) {
          const opened = await openOn(browser, playwright, world.stack, 'nadia', path, phone ? { viewport: PHONE, mobile: true } : {});
          const page = opened.page;
          try {
            await expect(page.getByTestId('todo-card')).toBeVisible({ timeout: 60_000 });
            await expect(page.getByTestId('todo-card').getByTestId('todo-progress')).toHaveText('2 of 4', { timeout: 30_000 });
            await expect(page.getByTestId('run-card')).toBeVisible();
            await expect(page.locator('html')).toHaveAttribute('data-palette', palette);
            await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
            await picturesLoaded(page);
            await page.getByTestId('todo-card').scrollIntoViewIfNeeded();
            // the faces of this theme are loaded (self-hosted files), and the workspace name is drawn in the title face while the messages keep the text face
            const faces = FACES[palette];
            await expect
              .poll(() => page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''))), { message: `${name}: the font files of the theme load` })
              .toEqual(expect.arrayContaining([faces.text, faces.title]));
            const used = await page.evaluate(() => {
              const family = (el: Element | null): string => (el ? getComputedStyle(el).fontFamily.split(',')[0]!.replace(/"/g, '').trim() : '');
              return { title: family(document.querySelector('.rail .team b')), text: family(document.querySelector('[data-testid="message"]')) };
            });
            expect(used, name).toEqual(faces);
            if (phone) expect(await noSidewaysScroll(page), `${name}: nothing scrolls sideways at 390 px`).toBe(true);
            for (const sel of ['[data-testid="run-card"]', '[data-testid="todo-card"]']) {
              const worst = await worstContrast(page, sel);
              expect(worst.ratio, `${name}${phone ? ' (390)' : ''} ${sel}: "${worst.text}" ${worst.fg} on ${worst.bg}`).toBeGreaterThanOrEqual(4.5);
            }
            await page.screenshot({ path: join(SHOTS, `${name}.${phone ? '390' : '1440'}.png`) });
          } finally {
            await opened.context.close();
          }
        }
      }
    }
    await api.ctx.put('/api/me/appearance', { data: { palette: 'classic', theme: 'system' }, headers: await api.headers() });
  } finally {
    await api.ctx.dispose();
    await omar.ctx.dispose();
    // the orchestrator's step is slow on purpose: the world is closed, which ends the run
  }
});

test('Settings → Appearance: the picker with its live samples, in a light and a dark theme, at 1440 px and at 390 px', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, world.stack, 'rafi');
  try {
    for (const [palette, mode] of [['graphite', 'light'], ['linen', 'dark'], ['harbor', 'light']] as const) {
      await setLook(api, palette, mode);
      for (const phone of [false, true]) {
        const opened = await openOn(browser, playwright, world.stack, 'rafi', '/account/appearance', phone ? { viewport: PHONE, mobile: true } : {});
        const page = opened.page;
        try {
          await expect(page.getByTestId('appearance-picker')).toBeVisible();
          await expect(page.getByTestId(`appearance-palette-${palette}`).getByRole('radio')).toBeChecked();
          await expect(page.locator('html')).toHaveAttribute('data-palette', palette);
          await picturesLoaded(page);
          if (phone) expect(await noSidewaysScroll(page), `${palette}.${mode}: nothing scrolls sideways at 390 px`).toBe(true);
          const worst = await worstContrast(page, '[data-testid="appearance-picker"] .ap-card');
          expect(worst.ratio, `${palette}.${mode} picker: "${worst.text}" ${worst.fg} on ${worst.bg}`).toBeGreaterThanOrEqual(4.5);
          await page.screenshot({ path: join(SHOTS, `settings.${palette}.${mode}.${phone ? '390' : '1440'}.png`), fullPage: true });
        } finally {
          await opened.context.close();
        }
      }
    }
  } finally {
    await api.ctx.dispose();
  }
});
