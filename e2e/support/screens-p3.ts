// Screenshots of the channel screens from the REAL server (not the mock), for docs/retro/screens/phase-3/. It starts its own seeded
// stack (fixtures/stack.ts, the same one the visual specs use), writes some conversation through the API, and drives the browser.
//   pnpm --filter @manythreads/web build && pnpm -C e2e exec tsx support/screens-p3.ts <out dir>
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, request, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PERSONA_PASSWORD, personaEmail, type PersonaKey } from './env.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: screens-p3.ts <out dir>');
mkdirSync(out, { recursive: true });
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const stack: Stack = await startStack();
const browser = await chromium.launch();

async function login(key: PersonaKey): Promise<{ api: APIRequestContext; csrf: () => Promise<Record<string, string>> }> {
  const api = await request.newContext({ baseURL: stack.origin });
  const res = await api.post('/api/auth/password/sign-in', { data: { email: personaEmail(key), password: PERSONA_PASSWORD } });
  if (!res.ok()) throw new Error(`sign-in as ${key}: ${res.status()}`);
  return { api, csrf: async () => Object.fromEntries((await api.storageState()).cookies.filter((c) => c.name === 'manythreads_csrf').map((c) => ['x-csrf-token', c.value])) };
}
type Who = Awaited<ReturnType<typeof login>>;
const send = async <T = unknown>(who: Who, path: string, data?: unknown): Promise<T> => {
  const res = await who.api.post(path, { data, headers: await who.csrf() });
  if (!res.ok()) throw new Error(`${path}: ${res.status()} ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
};

const [omar, nadia, rafi, priya] = [await login('omar'), await login('nadia'), await login('rafi'), await login('priya')];
const dir = (await (await rafi.api.get('/api/teams/engineering/channels')).json()) as { groups: Array<{ channels: Array<{ id: string; name: string }> }> };
const dev = dir.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'dev');
const releases = dir.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'releases');
if (!dev || !releases) throw new Error('template channels missing');

const post = async (who: Who, channelId: string, body: string, threadRootId: string | null = null, attachments?: string[]): Promise<{ id: string }> =>
  send<{ id: string }>(who, `/api/channels/${channelId}/messages`, { channelId, body, threadRootId, ...(attachments ? { attachments } : {}) });
const upload = async (who: Who, channelId: string, name: string, bytes: Buffer, type: string): Promise<{ id: string }> => {
  const res = await who.api.post(`/api/channels/${channelId}/files`, { data: bytes, headers: { ...(await who.csrf()), 'content-type': type, 'x-file-name': encodeURIComponent(name) } });
  if (!res.ok()) throw new Error(`upload: ${res.status()} ${await res.text()}`);
  return (await res.json()) as { id: string };
};

const a = await post(nadia, dev.id, 'Release notes for **2.4** are drafted. Can someone check the `LED` section matches what QA saw?');
const pdf = await upload(nadia, dev.id, 'qa-batch-7-report.pdf', Buffer.from('%PDF-1.4\n%fake\n'.repeat(4000)), 'application/pdf');
await post(nadia, dev.id, 'QA batch is done: 48 of 50 boards pass. Two have the LED flicker again, same as last batch.', null, [pdf.id]);
const c = await post(omar, dev.id, '@nadia per-device schedules need a migration for the old household profile.\n\n- existing profiles move to a household default\n- every device inherits it\n- the upgrade test passes on a 2.3 fixture');
await post(rafi, dev.id, 'Merged the rollback fix. See #releases for the checklist.');
await post(rafi, dev.id, 'On it, I will take the rollback runbook.', a.id);
await post(nadia, dev.id, 'Thanks, Rafi. I will update the notes once the fixture is in.', a.id);
await post(rafi, dev.id, 'Matches what I saw. One typo in the DNS paragraph.', a.id);
await post(omar, releases.id, 'Freeze is Thursday 17:00.');
await send(omar, `/api/channels/${dev.id}/messages/${c.id}/reactions`, { emoji: '👍' });
await send(rafi, `/api/channels/${dev.id}/messages/${c.id}/reactions`, { emoji: '👍' });
await send(nadia, `/api/channels/${dev.id}/messages/${c.id}/reactions`, { emoji: '🚀' });
await post(priya, dev.id, 'Reading along, thanks for the notes.');
await post(nadia, dev.id, 'Priya, welcome to the channel.');

async function openAs(key: PersonaKey, viewport: typeof DESKTOP, mobile = false): Promise<{ context: BrowserContext; page: Page }> {
  const api = await request.newContext({ baseURL: stack.origin });
  await api.post('/api/auth/password/sign-in', { data: { email: personaEmail(key), password: PERSONA_PASSWORD } });
  const storageState = await api.storageState();
  await api.dispose();
  const context = await browser.newContext({ baseURL: stack.origin, viewport, storageState, reducedMotion: 'reduce', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  return { context, page: await context.newPage() };
}
const settle = async (page: Page): Promise<void> => {
  await page.locator('[data-testid="app-frame"]').waitFor();
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(700);
};

{
  // channel with the thread open in the right panel (Rafi), then the Threads inbox
  const { context, page } = await openAs('rafi', DESKTOP);
  await page.goto(`/t/engineering/c/dev?panel=thread:${a.id}`);
  await page.locator('[data-testid="message"]').first().waitFor();
  await settle(page);
  await page.screenshot({ path: `${out}/channel-thread-1440.png` });
  await page.goto('/t/engineering/threads');
  await page.getByTestId('thread-row').first().waitFor();
  await settle(page);
  await page.screenshot({ path: `${out}/threads-inbox-1440.png` });
  await context.close();
}
{
  // composer: markdown toolbar, a finished upload and a refused one; then the mention picker
  const { context, page } = await openAs('priya', DESKTOP);
  await page.goto('/t/engineering/c/dev');
  await page.locator('[data-testid="message"]').first().waitFor();
  const box = page.getByRole('textbox', { name: 'Message #dev' });
  const tmp = mkdtempSync(join(tmpdir(), 'mt-shot-'));
  const pdfFile = join(tmp, 'incident-review.pdf');
  const big = join(tmp, 'big.zip'); // over the 50 MB limit: refused before a byte is sent
  writeFileSync(pdfFile, Buffer.from('%PDF-1.4\n%review\n'.repeat(3000)));
  writeFileSync(big, Buffer.alloc(51 * 1024 * 1024));
  await page.locator('input[type=file]').setInputFiles([pdfFile, big]);
  await page.getByTestId('upload').filter({ hasText: 'incident-review.pdf' }).waitFor();
  await page.locator('[data-testid="upload"][data-status="done"]').waitFor({ timeout: 15000 });
  await box.fill('Notes from the incident review. Please check the timeline.');
  await settle(page);
  await page.screenshot({ path: `${out}/composer-attachment-1440.png` });
  await box.fill('Notes from the incident review. Thanks @na');
  await page.getByRole('listbox', { name: 'People' }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/composer-picker-1440.png` });
  await context.close();
}
{
  // phone: the channel, and its thread as a full sheet
  const { context, page } = await openAs('rafi', MOBILE, true);
  await page.goto('/t/engineering/c/dev');
  await page.locator('[data-testid="message"]').first().waitFor();
  await settle(page);
  await page.screenshot({ path: `${out}/channel-390.png` });
  await page.goto(`/t/engineering/c/dev?panel=thread:${a.id}`);
  await page.getByTestId('thread-view').waitFor();
  await settle(page);
  await page.screenshot({ path: `${out}/thread-390.png` });
  await context.close();
}

await browser.close();
await stack.stop();
console.log(`screenshots written to ${out}`);
