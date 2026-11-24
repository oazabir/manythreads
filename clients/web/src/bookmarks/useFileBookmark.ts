import { useContext, useEffect, useMemo } from 'react';
import { bookmarkKey, type BookmarkTarget } from '@manythreads/shared';
import { ShellContext } from '../shell/context';
import type { FileRow } from '../screens/files/model';
import type { TeamFiles } from '../screens/files/store';
import { toggleBookmark } from './actions';
import { fileBookmarkTarget } from './fileTarget';
import { bookmarksStore, useBookmarkPending, useBookmarked, useBookmarksReady } from './store';

/** The id of the team whose Files these are (a repository file is kept by its team); null for Personal and for a team not in the person's list. */
export function useFilesTeamId(files: Pick<TeamFiles, 'slug' | 'space'> | null): string | null {
  const teams = useContext(ShellContext)?.teams;
  const slug = files && files.space !== 'personal' ? files.slug : null;
  // looked up once per list of teams, not once per row and render
  return useMemo(() => (slug === null ? null : (teams?.find((t) => t.slug === slug)?.id ?? null)), [teams, slug]);
}

/** The target of a Files row as a bookmark, for the team in sight; the same object while the row's own fields stay the same. */
export function useFileBookmarkTarget(row: FileRow, files: Pick<TeamFiles, 'slug' | 'space'> | null): BookmarkTarget | null {
  const teamId = useFilesTeamId(files);
  const { kind, store, path, fileId, readOnlyReason } = row;
  return useMemo(() => fileBookmarkTarget({ kind, store, path, fileId, readOnlyReason }, teamId), [kind, store, path, fileId, readOnlyReason, teamId]);
}

/**
 * The bookmark entry of a row's menu, listening to the client's copy (only this target's answer): it appears once the keys are in and follows a change made
 * in another tab. Null where bookmarks are not offered.
 */
export function useFileBookmarkAct(target: BookmarkTarget | null): BookmarkAct | null {
  const ready = useBookmarksReady();
  const kind = target?.kind ?? 'file';
  const key = target ? bookmarkKey(target) : '';
  const on = useBookmarked(kind, key);
  const busy = useBookmarkPending(kind, key);
  const wanted = target !== null;
  useEffect(() => {
    if (wanted) void bookmarksStore.load();
  }, [wanted]);
  return useMemo(() => (ready && target ? { on, busy, toggle: () => void toggleBookmark(target) } : null), [ready, target, on, busy]);
}

/** A row menu's bookmark entry as the client's copy holds it now (the right-click menu, built when it opens); null where bookmarks are not offered. */
export type BookmarkAct = { on: boolean; busy: boolean; toggle: () => void };
export function bookmarkActOf(target: BookmarkTarget | null): BookmarkAct | null {
  const snap = bookmarksStore.snapshot();
  if (!target || !snap.supported || !snap.loaded) return null;
  const key = bookmarkKey(target);
  return { on: bookmarksStore.has(target.kind, key), busy: bookmarksStore.isPending(target.kind, key), toggle: () => void toggleBookmark(target) };
}
