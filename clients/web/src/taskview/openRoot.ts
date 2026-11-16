import { useSyncExternalStore } from 'react';

/** Which thread root the right panel has open now, so the channel's task view for that root folds to its chip (the panel shows the same, answerable, once). */
let current: string | null = null;
const listeners = new Set<() => void>();

export function setOpenThreadRoot(rootId: string | null): void {
  if (current === rootId) return;
  current = rootId;
  for (const l of [...listeners]) l();
}

export function useIsOpenInPanel(rootId: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current === rootId,
    () => false,
  );
}
