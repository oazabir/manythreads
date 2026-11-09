// A real Chromium for the harness tests that need a page (shot checks, tab walk, journey runs). Pages are served by route handlers on a made-up address, so no
// server and no stack start. Shared by shot.test.ts, tabwalk.test.ts and run.test.ts.
import { chromium, type Browser, type Page } from '@playwright/test';
import { monitorPage } from '../monitor.ts';

export const ORIGIN = 'http://harness.test';

let browser: Browser | undefined;

export async function launch(): Promise<Browser> {
  browser ??= await chromium.launch();
  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = undefined;
}

export interface Served {
  page: Page;
  close: () => Promise<void>;
}

/** The body that makes a picture a screen and not a blank page: a gradient has hundreds of colours. */
export const BUSY = '<div style="height:300px;background:linear-gradient(90deg,red,lime,blue,magenta,yellow,cyan,red)"></div>';

/** `<html>` with `data-ready` already set (the web client sets it once its requests are done). */
export const screen = (body: string, options: { ready?: 'true' | 'false' | null; script?: string } = {}): string => {
  const ready = options.ready === undefined ? 'true' : options.ready;
  return `<!doctype html><html lang="en"${ready === null ? '' : ` data-ready="${ready}"`}><head><title>t</title></head><body style="margin:0">${body}${options.script ? `<script>${options.script}</script>` : ''}</body></html>`;
};

/** Opens a page whose `/` answers `html`; `routes` answers other paths (default 404). */
export async function serve(html: string, routes: Record<string, { status?: number; body?: string; abort?: boolean }> = {}): Promise<Served> {
  const context = await (await launch()).newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    const hit = routes[path];
    if (hit?.abort) return route.abort('connectionrefused');
    return route.fulfill({ status: hit?.status ?? 404, contentType: 'application/json', body: hit?.body ?? '{}' });
  });
  // as `loginAs` does: the monitor is listening before the first request, so what the first load logs is judged by the first picture
  monitorPage(page);
  await page.goto(`${ORIGIN}/`);
  return { page, close: () => context.close() };
}
