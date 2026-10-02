import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '../../api/client';
import type { Listing } from './model';
import { useFilesVersion, type TeamFiles } from './store';

export type FolderState =
  | { status: 'loading'; listing?: Listing }
  | { status: 'ok'; listing: Listing }
  | { status: 'error'; code: 'forbidden' | 'missing' | 'other'; message: string; listing?: Listing };

/**
 * The folders the Files screen has asked for: the tree's open folders and the one in the list. A folder is fetched once and kept; after any
 * change (the shared counter moves) every folder that is still wanted is fetched again, and the old listing stays on screen until the new one arrives.
 */
export function useFolders(files: TeamFiles | null): { get: (path: string) => FolderState | undefined; want: (paths: readonly string[]) => void } {
  const version = useFilesVersion();
  const cache = useRef(new Map<string, FolderState>());
  const fresh = useRef(new Map<string, number>());
  const wanted = useRef(new Set<string>());
  const [, render] = useState(0);
  const owner = useRef(files);

  const load = useCallback(
    (path: string): void => {
      if (!files) return;
      const stamp = version;
      fresh.current.set(path, stamp);
      const before = cache.current.get(path);
      cache.current.set(path, before?.listing ? { status: 'loading', listing: before.listing } : { status: 'loading' });
      files.backend.list(path).then(
        (listing) => {
          if (owner.current !== files) return;
          cache.current.set(path, { status: 'ok', listing });
          render((n) => n + 1);
        },
        (err: unknown) => {
          if (owner.current !== files) return;
          const status = isApiError(err) ? err.status : 0;
          const prior = cache.current.get(path)?.listing;
          cache.current.set(path, {
            status: 'error',
            code: status === 403 ? 'forbidden' : status === 404 ? 'missing' : 'other',
            message: err instanceof Error ? err.message : 'The folder could not be loaded.',
            ...(prior ? { listing: prior } : {}),
          });
          render((n) => n + 1);
        },
      );
      render((n) => n + 1);
    },
    [files, version],
  );

  // another team or person: nothing from before is shown
  useEffect(() => {
    owner.current = files;
    cache.current.clear();
    fresh.current.clear();
    wanted.current.clear();
    render((n) => n + 1);
  }, [files]);

  const want = useCallback(
    (paths: readonly string[]): void => {
      for (const p of paths) {
        wanted.current.add(p);
        if (fresh.current.get(p) !== version || !cache.current.has(p)) load(p);
      }
    },
    [load, version],
  );

  // after a change, fetch again what is still wanted
  useEffect(() => {
    for (const p of wanted.current) if (fresh.current.get(p) !== version && files) load(p);
  }, [version, files, load]);

  return { get: (path) => cache.current.get(path), want };
}
