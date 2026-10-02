/**
 * P1-11 phone list benchmark PROXY. NOT the guide section 5.1 benchmark: the real one (React Native on a mid-range Android
 * device) cannot run in this sandbox (no device or emulator) and is deferred to the phase 11 gate. This renders a
 * hand-windowed 5,000-message React list in Chromium (390x844, CDP CPU throttle x4 as a mid-range Android
 * approximation), scrolls top to bottom and reports requestAnimationFrame frame times.
 * Run: pnpm --filter @manythreads/tools-bench bench:list
 */
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';
import { build } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../list');
const out = join(tmpdir(), 'manythreads-bench-list');
const THROTTLE = Number(process.env['BENCH_CPU_THROTTLE'] ?? 4);
const SCROLL_MS = Number(process.env['BENCH_SCROLL_MS'] ?? 10_000);
const RUNS = Number(process.env['BENCH_RUNS'] ?? 3);
const FRAME_MS = 1000 / 60;

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
}

interface Sample { frames: number[]; heapMB: number | null; heapStartMB: number | null }

async function measure(throttle: number): Promise<{ clusters: number; avgFps: number; p50: number; p95: number; p99: number; dropped: number; total: number; heap: string }> {
  const server = createServer((req, res) => {
    const rel = (req.url ?? '/').split('?')[0] === '/' ? '/index.html' : (req.url ?? '').split('?')[0] as string;
    const file = join(out, rel);
    if (!file.startsWith(out) || !existsSync(file)) { res.writeHead(404).end(); return; }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => Boolean((window as unknown as { __bench?: unknown }).__bench));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    const bench = (ms: number) => page.evaluate((m) => (window as unknown as { __bench: { run(ms: number): Promise<Sample> } }).__bench.run(m), ms);
    await bench(2000); // warm-up
    const all: number[] = [];
    let heap = 'n/a';
    for (let i = 0; i < RUNS; i++) {
      const s = await bench(SCROLL_MS);
      all.push(...s.frames);
      if (s.heapMB !== null && s.heapStartMB !== null) heap = `${s.heapStartMB.toFixed(1)} -> ${s.heapMB.toFixed(1)} MB JS heap (last run)`;
    }
    const rendered = await page.evaluate(() => document.querySelectorAll('[data-testid=list] > div > div').length);
    const sum = all.reduce((a, b) => a + b, 0);
    // A frame is "dropped" when it took longer than 1.5 vsync intervals (a missed vsync).
    const dropped = all.filter((f) => f > FRAME_MS * 1.5).length;
    // Isolated single drops are allowed by the criterion; count runs of 2+ consecutive dropped frames.
    let clusters = 0;
    for (let i = 1; i < all.length; i++) {
      if ((all[i] as number) > FRAME_MS * 1.5 && (all[i - 1] as number) > FRAME_MS * 1.5) {
        clusters++;
        while (i < all.length && (all[i] as number) > FRAME_MS * 1.5) i++;
      }
    }
    return {
      clusters, avgFps: (all.length / sum) * 1000, p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99),
      dropped: (dropped / all.length) * 100, total: all.length, heap: `${heap}; DOM rows mounted at end: ${rendered}`,
    };
  } finally {
    await browser.close();
    server.close();
  }
}

async function main(): Promise<void> {
  await build({ root, base: './', logLevel: 'warn', plugins: [react()], build: { outDir: out, emptyOutDir: true } });
  console.log(`list proxy: 5,000 messages, hand-windowed React 19 list, Chromium 390x844 dpr2, ${RUNS} x ${SCROLL_MS / 1000}s top->bottom scrolls`);
  for (const rate of [1, THROTTLE]) {
    const r = await measure(rate);
    console.log(
      `CPU throttle x${rate}: avg ${r.avgFps.toFixed(1)} fps | frame p50 ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, p99 ${r.p99.toFixed(1)} ms | dropped ${r.dropped.toFixed(1)}% of ${r.total} frames (${r.clusters} multi-frame stalls) | ${r.heap}`,
    );
    if (rate === THROTTLE) {
      const pass = r.p95 < 17 && r.dropped < 2;
      console.log(`60 fps: ${pass ? 'PASS' : 'FAIL'} (criterion: p95 frame time < 17 ms and under 2% dropped frames (occasional drops) at throttle x${THROTTLE}; PROXY ONLY)`);
    }
  }
  console.log('NOTE: proxy only. The true React Native on-device Android benchmark (guide 5.1) cannot run in this sandbox and is deferred to the phase 11 gate.');
}

main().catch((e) => { console.error(e); process.exit(1); });
