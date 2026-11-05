import { useEffect, useSyncExternalStore } from 'react';

/*
 * Short notices at the bottom left (P21-05): "Conversation marked as read." with an Undo when the notice changed what the reader has read.
 * One list for the whole app; a notice goes by itself after a few seconds (longer when it carries Undo), a new one replaces the old.
 */

export type ToastOptions = { undo?: () => void | Promise<void>; ms?: number; /** Names the text itself (not the Undo beside it), for tests. */ testId?: string };
export type ToastItem = { id: number; text: string; undo?: () => void | Promise<void>; ms: number; testId?: string };

export const TOAST_MS = 4_000;
export const TOAST_UNDO_MS = 8_000;
const MAX = 3;

let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const emit = (): void => listeners.forEach((l) => l());

export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  if (!items.some((i) => i.id === id)) return;
  items = items.filter((i) => i.id !== id);
  emit();
}

/** Shows a notice. The newest three stay; the same text shown again replaces the earlier one. */
export function sayToast(text: string, opts: ToastOptions = {}): number {
  const id = nextId++;
  const ms = opts.ms ?? (opts.undo ? TOAST_UNDO_MS : TOAST_MS);
  for (const old of items.filter((i) => i.text === text)) dismissToast(old.id);
  items = [...items, { id, text, ms, ...(opts.undo ? { undo: opts.undo } : {}), ...(opts.testId ? { testId: opts.testId } : {}) }].slice(-MAX);
  timers.set(id, setTimeout(() => dismissToast(id), ms));
  emit();
  return id;
}

/** Empties the list and stops every timer (a test starts clean). */
export function clearToasts(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  items = [];
  emit();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = (): readonly ToastItem[] => items;

export function useToast(): { say: typeof sayToast } {
  return { say: sayToast };
}

/** Mounted once, above every signed-in screen. */
export function ToastHost() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => clearToasts, []);
  if (list.length === 0) return null;
  return (
    <div className="toasts" data-testid="toasts">
      {list.map((t) => (
        <div key={t.id} className="toast" role="status" data-testid="toast">
          <span data-testid={t.testId}>{t.text}</span>
          {t.undo ? (
            <button
              type="button"
              className="toast-undo"
              onClick={() => {
                dismissToast(t.id);
                void t.undo?.();
              }}
            >
              Undo
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
