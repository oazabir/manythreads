import { expect, test } from '@playwright/test';
import { apiAs, bulkMessages, createChannel, openAs } from './support.ts';

/**
 * PLAN criterion 9: a channel of 5,000 messages scrolls at p95 frame time under 20 ms. Frames are sampled with requestAnimationFrame
 * while a script scrolls the list for 10 seconds (up through older pages that load as the top is reached, then back down).
 */
test('5,000 messages: 10 s of scrolling, p95 frame under 20 ms, a few dozen rows in the DOM', async ({ browser }) => {
  test.setTimeout(180_000);
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'busy');
  await bulkMessages(omar, id, 5000);
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    const { page } = rafi;
    await expect(page.locator('[data-testid="message"]').last()).toContainText('bulk 5000');

    const result = await page.evaluate(
      (ms) =>
        new Promise<{ p50: number; p95: number; max: number; frames: number; maxRows: number; farthest: number; startTop: number }>((resolve) => {
          const el = document.querySelector<HTMLElement>('.vlist');
          if (!el) throw new Error('no list');
          const deltas: number[] = [];
          let last = performance.now();
          const start = last;
          const startTop = el.scrollTop;
          let maxRows = 0;
          let farthest = 0;
          const tick = (now: number): void => {
            deltas.push(now - last);
            last = now;
            const t = now - start;
            // 0 to 6.5 s up (fast: about 13,000 px/s; older pages load as the top is reached), then 3.5 s back down
            const dir = t < 6_500 ? -1 : 1;
            el.scrollTop += dir * (t < 6_500 ? 220 : 260);
            farthest = Math.max(farthest, el.scrollHeight - el.scrollTop - el.clientHeight);
            maxRows = Math.max(maxRows, el.querySelectorAll('[data-testid="message"],[data-testid="unread-divider"]').length);
            if (t < ms) requestAnimationFrame(tick);
            else {
              const sorted = [...deltas.slice(2)].sort((a, b) => a - b);
              const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
              resolve({ p50: q(0.5), p95: q(0.95), max: sorted[sorted.length - 1] ?? 0, frames: sorted.length, maxRows, farthest, startTop });
            }
          };
          requestAnimationFrame(tick);
        }),
      10_000,
    );
    console.log(`perf-5000: ${JSON.stringify(result)}`);
    expect(result.frames).toBeGreaterThan(300);
    expect(result.farthest).toBeGreaterThan(50_000); // it really travelled up through a thousand rows or more, loading older pages on the way
    expect(result.maxRows).toBeLessThan(120); // windowed: never the whole channel in the DOM
    expect(result.p95).toBeLessThan(20);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
  }
});
