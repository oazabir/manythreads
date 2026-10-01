// Hand-rolled windowed list of 5,000 chat messages. Exposes window.__bench for tools/bench/src/list.ts.
import { createElement as h, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

const COUNT = 5000;
const ROW = 76; // fixed row height (px): avatar + name line + two text lines
const OVERSCAN = 6;
const WORDS = 'ship the release notes before friday and ping the team about the rollback plan review my draft thanks looks good'.split(' ');

interface Msg { id: number; author: string; time: string; text: string }
const messages: Msg[] = Array.from({ length: COUNT }, (_, i) => ({
  id: i,
  author: ['Amal', 'Bilal', 'Carmen', 'Dev', 'Eun'][i % 5] as string,
  time: `${String(9 + Math.floor(i / 300) % 12).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`,
  text: Array.from({ length: 10 + (i % 14) }, (_, k) => WORDS[(i * 3 + k * 5) % WORDS.length]).join(' '),
}));

function Row({ m, top }: { m: Msg; top: number }) {
  return h('div', { style: { position: 'absolute', top, left: 0, right: 0, height: ROW, display: 'flex', gap: 10, padding: '8px 12px', boxSizing: 'border-box' } },
    h('div', { style: { width: 36, height: 36, borderRadius: 18, background: `hsl(${(m.id % 5) * 60} 50% 50%)`, flex: 'none' } }),
    h('div', { style: { minWidth: 0 } },
      h('div', { style: { fontWeight: 600, fontSize: 14 } }, m.author, h('span', { style: { fontWeight: 400, color: 'gray', marginLeft: 8, fontSize: 12 } }, m.time)),
      h('div', { style: { fontSize: 14, lineHeight: '18px', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const } }, m.text),
    ));
}

function List() {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ from: 0, to: 20 });
  useEffect(() => {
    const el = ref.current as HTMLDivElement;
    const update = () => {
      const from = Math.max(0, Math.floor(el.scrollTop / ROW) - OVERSCAN);
      const to = Math.min(COUNT, Math.ceil((el.scrollTop + el.clientHeight) / ROW) + OVERSCAN);
      setRange((r) => (r.from === from && r.to === to ? r : { from, to }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    (window as unknown as { __bench: unknown }).__bench = {
      count: COUNT,
      /** Scroll top to bottom over `ms`, sampling every animation frame. */
      run(ms: number): Promise<{ frames: number[]; scrollTop: number; maxScroll: number; heapMB: number | null; heapStartMB: number | null }> {
        const heap = () => { const p = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory; return p ? p.usedJSHeapSize / 1048576 : null; };
        const heapStartMB = heap();
        const max = el.scrollHeight - el.clientHeight;
        el.scrollTop = 0;
        return new Promise((resolve) => {
          const frames: number[] = [];
          let start = 0;
          let last = 0;
          const tick = (now: number) => {
            if (!start) { start = now; last = now; } else { frames.push(now - last); last = now; }
            const f = Math.min(1, (now - start) / ms);
            el.scrollTop = f * max;
            if (f < 1) requestAnimationFrame(tick);
            else requestAnimationFrame(() => resolve({ frames, scrollTop: el.scrollTop, maxScroll: max, heapMB: heap(), heapStartMB }));
          };
          requestAnimationFrame(tick);
        });
      },
    };
    return () => el.removeEventListener('scroll', update);
  }, []);
  const rows = [];
  for (let i = range.from; i < range.to; i++) rows.push(h(Row, { key: i, m: messages[i] as Msg, top: i * ROW }));
  return h('div', { ref, 'data-testid': 'list', style: { height: '100%', overflowY: 'auto', position: 'relative', contain: 'strict' } },
    h('div', { style: { height: COUNT * ROW, position: 'relative' } }, rows));
}

createRoot(document.getElementById('root') as HTMLElement).render(h(List));
