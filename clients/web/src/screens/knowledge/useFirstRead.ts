import { useEffect } from 'react';
import type { KnowledgeSource } from '@manythreads/shared';

/** True while a connected app's first read has not finished: the source is working and nothing was read from it yet. */
export const firstReadPending = (sources: readonly Pick<KnowledgeSource, 'kind' | 'status' | 'lastSyncedAt' | 'error'>[]): boolean =>
  sources.some((s) => s.kind === 'connector' && (s.status ?? 'ready') === 'ready' && s.lastSyncedAt === null && !s.error);

/** How long (in tries, three seconds apart) a screen asks again for a first read before it gives up and leaves the rest to the person's own reload. */
export const FIRST_READ_TRIES = 40;
export const FIRST_READ_EVERY_MS = 3000;

/**
 * A folder added from a connected app is read by a background job a few seconds after the person pressed Add, so the list they see right after has no documents in it. While that first read
 * is pending, load the base again every few seconds, so the documents appear without a manual reload; it stops by itself when the read is done or after about two minutes.
 */
export function useFirstReadRefresh(pending: boolean, reload: () => void): void {
  useEffect(() => {
    if (!pending) return undefined;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (tries > FIRST_READ_TRIES) clearInterval(timer);
      else reload();
    }, FIRST_READ_EVERY_MS);
    return () => clearInterval(timer);
  }, [pending, reload]);
}
