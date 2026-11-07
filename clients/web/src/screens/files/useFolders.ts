import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '../../api/client';
import type { Listing } from './model';
import { useFilesVersion, type TeamFiles } from './store';

export type FolderState =
  | { status: 'loading'; listing?: Listing }
  | { status: 'ok'; listing: Listing }
  | { status: 'error'; code: 'forbidden' | 'missing' | 'other'; message: string; listing?: Listing };

export type Folders = {
  get: (space: string, path: string) => FolderState | undefined;
  want: (space: string, paths: readonly string[]) => void;
};

const keyOf = (space: string, path: string): string => `${space}\0${path}`;

/**
 * The folders the Files screen has asked for, in any space: the tree's open folders and the one in the list. A folder is fetched once and kept; after any
 * change (the shared counter moves) every folder that is still wanted is fetched again, and the old listing stays on screen until the new one arrives.
 * A space whose store was replaced (the roster arrived, another person) forgets its folders.
 */
export function useFolders(lookup: (space: string) => TeamFiles | null): Folders {
  const version = useFilesVersion();
  const cache = useRef(new Map<string, FolderState>());
  const fresh = useRef(new Map<string, number>());
  /** The newest request per folder: an answer to an older one (slower, sent before a change) is dropped, never shown over the newer. */
  const latest = useRef(new Map<string, number>());
  const sent = useRef(0);
  const wanted = useRef(new Set<string>());
  const owners = useRef(new Map<string, TeamFiles>());
  const [, render] = useState(0);

  const sync = useCallback(
    (space: string): TeamFiles | null => {
      const files = lookup(space);
      const known = owners.current.get(space);
      if (files !== known) {
        for (const k of [...cache.current.keys()]) if (k.startsWith(`${space}\0`)) cache.current.delete(k);
        for (const k of [...fresh.current.keys()]) if (k.startsWith(`${space}\0`)) fresh.current.delete(k);
        for (const k of [...latest.current.keys()]) if (k.startsWith(`${space}\0`)) latest.current.delete(k);
        if (files) owners.current.set(space, files);
        else owners.current.delete(space);
      }
      return files;
    },
    [lookup],
  );

  const load = useCallback(
    (space: string, path: string): void => {
      const files = sync(space);
      if (!files) return;
      const key = keyOf(space, path);
      fresh.current.set(key, version);
      const mine = ++sent.current;
      latest.current.set(key, mine);
      const before = cache.current.get(key);
      cache.current.set(key, before?.listing ? { status: 'loading', listing: before.listing } : { status: 'loading' });
      files.backend.list(path).then(
        (listing) => {
          if (owners.current.get(space) !== files || latest.current.get(key) !== mine) return;
          cache.current.set(key, { status: 'ok', listing });
          render((n) => n + 1);
        },
        (err: unknown) => {
          if (owners.current.get(space) !== files || latest.current.get(key) !== mine) return;
          const status = isApiError(err) ? err.status : 0;
          const prior = cache.current.get(key)?.listing;
          cache.current.set(key, {
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
    [sync, version],
  );

  const want = useCallback(
    (space: string, paths: readonly string[]): void => {
      sync(space);
      for (const p of paths) {
        const key = keyOf(space, p);
        wanted.current.add(key);
        if (fresh.current.get(key) !== version || !cache.current.has(key)) load(space, p);
      }
    },
    [load, sync, version],
  );

  // after a change, fetch again what is still wanted
  useEffect(() => {
    for (const key of wanted.current) {
      if (fresh.current.get(key) === version) continue;
      const i = key.indexOf('\0');
      load(key.slice(0, i), key.slice(i + 1));
    }
  }, [version, load]);

  // a store that was replaced: what it showed is gone, and what is wanted loads again
  useEffect(() => {
    let changed = false;
    for (const space of new Set([...wanted.current].map((k) => k.slice(0, k.indexOf('\0'))))) {
      if (lookup(space) !== owners.current.get(space)) {
        sync(space);
        changed = true;
      }
    }
    if (changed) {
      for (const key of wanted.current) {
        const i = key.indexOf('\0');
        load(key.slice(0, i), key.slice(i + 1));
      }
      render((n) => n + 1);
    }
  }, [lookup, sync, load]);

  const get = useCallback((space: string, path: string) => cache.current.get(keyOf(space, path)), []);
  return { get, want };
}
