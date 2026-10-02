import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { anchorAt, buildOffsets, scrollTopFor, shiftAfter, windowFor, type Anchor } from './virtual';

export type VirtualListApi = {
  scrollToBottom(): void;
  /** Bring a row to near the top of the view; false when the row is not in the list. */
  scrollToKey(key: string): boolean;
};

type Props<T> = {
  items: readonly T[];
  getKey: (item: T) => string;
  /** The height to assume before a row has been measured. */
  estimate: (item: T) => number;
  render: (item: T, index: number) => ReactNode;
  /** Which rows may anchor the reader's place while rows are added above (default: all). Dividers should say no. */
  anchorable?: (item: T) => boolean;
  className?: string;
  /** Called while the view is near the top: the caller loads older rows (and guards against repeated calls). */
  onNearTop?: () => void;
  /** True while the last row is in view (within 24 px). */
  onBottomChange?: (atBottom: boolean) => void;
  /** Slots in the scroll area before and after the rows (the "start of channel" header, the typing line). */
  header?: ReactNode;
  footer?: ReactNode;
  apiRef?: Ref<VirtualListApi>;
  label: string;
};

const OVERSCAN = 700;
const REPAINT_AFTER = 220;
const NEAR_TOP = 900;
const AT_BOTTOM = 24;

/**
 * A hand-made windowed list for chat: newest at the bottom, rows of unknown height (measured with a ResizeObserver), the view
 * stays glued to the bottom while the reader is there, older rows can be added in front without the view jumping, and a row
 * growing above the viewport does not push the reader's text down (WebKit has no `overflow-anchor`, so this is done by hand).
 */
export function VirtualList<T>({ items, getKey, estimate, render, anchorable, className, onNearTop, onBottomChange, header, footer, apiRef, label }: Props<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const topSpacer = useRef<HTMLDivElement>(null);
  const headerBox = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const stuck = useRef(true);
  const atBottom = useRef(true);
  const lastPaintTop = useRef(Number.MAX_SAFE_INTEGER);
  const anchor = useRef<Anchor | null>(null);
  const lastKeys = useRef<readonly string[]>([]);
  const [, bump] = useState(0);
  const estimated = useRef(new Map<string, number>());
  const [viewport, setViewport] = useState({ top: Number.MAX_SAFE_INTEGER, h: 800 });

  const keys = useMemo(() => items.map(getKey), [items, getKey]);
  // Built in full when the rows change; a measurement then only shifts the rows after the one that changed (`shiftAfter`), so a
  // frame of scrolling does not walk all 5,000 rows. `version` re-renders after a measurement.
  const offsets = useMemo(
    () =>
      buildOffsets(keys, heights.current, (i) => {
        const guess = estimate(items[i] as T);
        estimated.current.set(keys[i] as string, guess);
        return guess;
      }),
    [keys, items, estimate],
  );
  const listTop = useRef(0);
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const anchorableRef = useRef(anchorable);
  anchorableRef.current = anchorable;
  const takeAnchor = useCallback((scrollTop: number): Anchor | null => {
    const fn = anchorableRef.current;
    return anchorAt(keysRef.current, offsetsRef.current, listTop.current, scrollTop, fn ? (i) => fn(itemsRef.current[i] as T) : undefined);
  }, []);
  const win = windowFor(offsets, viewport.top - listTop.current, viewport.h, OVERSCAN);

  const nearTop = useRef(onNearTop);
  const bottomCb = useRef(onBottomChange);
  useEffect(() => {
    nearTop.current = onNearTop;
    bottomCb.current = onBottomChange;
  });

  const sync = useCallback((force: boolean): void => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    if (force || Math.abs(top - lastPaintTop.current) > REPAINT_AFTER) {
      lastPaintTop.current = top;
      setViewport({ top, h: el.clientHeight });
    }
  }, []);

  const onScroll = useCallback((): void => {
    const el = scroller.current;
    if (!el) return;
    const now = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM;
    stuck.current = now;
    anchor.current = takeAnchor(el.scrollTop);
    if (now !== atBottom.current) {
      atBottom.current = now;
      bottomCb.current?.(now);
    }
    sync(false);
    if (el.scrollTop < NEAR_TOP) nearTop.current?.();
  }, [sync, takeAnchor]);

  // One observer for every row and for the scroller itself.
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = scroller.current;
      if (!box) return;
      let shift = 0;
      let changed = false;
      const viewTop = box.getBoundingClientRect().top;
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (target === box) {
          changed = true;
          continue;
        }
        if (target === headerBox.current) {
          // the header above the rows changed height: the rows moved with it, and the reader's place must not
          const top = topSpacer.current?.offsetTop ?? 0;
          if (!stuck.current && top !== listTop.current) shift += top - listTop.current;
          listTop.current = top;
          changed = true;
          continue;
        }
        const key = target.dataset['key'];
        if (!key) continue;
        const h = Math.round(entry.borderBoxSize[0]?.blockSize ?? target.offsetHeight);
        const old = heights.current.get(key) ?? estimated.current.get(key);
        if (heights.current.get(key) === h) continue;
        heights.current.set(key, h);
        changed = true;
        if (old !== undefined && old !== h) {
          const at = Number(target.dataset['index']);
          const row = keysRef.current[at] === key ? at : keysRef.current.indexOf(key);
          if (row >= 0) shiftAfter(offsetsRef.current, row, h - old);
        }
        // a row that starts above the viewport is not the height the list assumed: keep what the reader looks at where it was
        if (old !== undefined && !stuck.current && target.getBoundingClientRect().top < viewTop) shift += h - old;
      }
      if (!changed) return;
      if (shift !== 0) box.scrollTop += shift;
      if (stuck.current) box.scrollTop = box.scrollHeight;
      bump((v) => v + 1);
      sync(true);
    });
    observer.current = ro;
    ro.observe(el);
    if (headerBox.current) ro.observe(headerBox.current);
    listTop.current = topSpacer.current?.offsetTop ?? 0;
    for (const row of el.querySelectorAll('[data-key]')) ro.observe(row);
    return () => {
      ro.disconnect();
      observer.current = null;
    };
  }, [sync]);

  const watchRow = useCallback((row: HTMLDivElement | null): (() => void) | void => {
    if (!row) return;
    observer.current?.observe(row);
    return () => observer.current?.unobserve(row);
  }, []);

  // After every commit: remember where the list starts, keep the bottom, and keep the view still when older rows arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs after each commit on purpose; every state change inside it is guarded
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // rows were added or removed above what the reader is looking at: scroll so that row stays where it was on screen
    const changed = lastKeys.current !== keys;
    lastKeys.current = keys;
    // a render only because the window moved: nothing to restore, and no layout to force by reading the scroll position
    if (!changed && !stuck.current) return;
    const want = changed && !stuck.current && anchor.current ? scrollTopFor(anchor.current, keys, offsetsRef.current, listTop.current) : null;
    if (want !== null && Math.abs(want - el.scrollTop) > 0.5) {
      el.scrollTop = want;
      lastPaintTop.current = el.scrollTop;
      setViewport({ top: el.scrollTop, h: el.clientHeight });
    } else if (stuck.current) {
      if (el.scrollTop !== el.scrollHeight - el.clientHeight) el.scrollTop = el.scrollHeight;
      if (viewport.top === Number.MAX_SAFE_INTEGER || Math.abs(el.scrollTop - lastPaintTop.current) > REPAINT_AFTER) {
        lastPaintTop.current = el.scrollTop;
        setViewport({ top: el.scrollTop, h: el.clientHeight });
      }
    }
    anchor.current = takeAnchor(el.scrollTop);
    // at the top with older rows still to come, and no scroll event to say so (the view cannot move further up): ask again
    if (el.scrollTop < NEAR_TOP) nearTop.current?.();
  });

  useImperativeHandle(apiRef, () => ({
    scrollToBottom() {
      const el = scroller.current;
      if (!el) return;
      stuck.current = true;
      el.scrollTop = el.scrollHeight;
      sync(true);
    },
    scrollToKey(key) {
      const el = scroller.current;
      const i = keys.indexOf(key);
      if (!el || i < 0) return false;
      stuck.current = false;
      el.scrollTop = listTop.current + (offsetsRef.current[i] as number) - 72;
      sync(true);
      return true;
    },
  }), [keys, sync]);

  const total = offsets[keys.length] as number;
  const start = Math.min(win.start, keys.length);
  const end = Math.min(win.end, keys.length);
  const rows: ReactNode[] = [];
  for (let i = start; i < end; i += 1) {
    const item = items[i] as T;
    const key = keys[i] as string;
    rows.push(
      <div key={key} data-key={key} data-index={i} className="vrow" ref={watchRow}>
        {render(item, i)}
      </div>,
    );
  }
  return (
    <div ref={scroller} className={`vlist ${className ?? ''}`} onScroll={onScroll} role="log" aria-label={label} aria-live="off" tabIndex={0}>
      <div ref={headerBox}>{header}</div>
      <div ref={topSpacer} style={{ height: offsets[start] ?? 0 }} aria-hidden="true" />
      {rows}
      <div style={{ height: Math.max(0, total - ((offsets[end] as number | undefined) ?? total)) }} aria-hidden="true" />
      {footer}
    </div>
  );
}
