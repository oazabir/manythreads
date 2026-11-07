import { useCallback, useEffect, useRef } from 'react';
import { DRAFT_MAX_CHARS, type SaveDraftRequest } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { deleteDraft, fetchDrafts, saveDraft } from '../api/endpoints';

/*
 * The text a person has typed and not sent (PLAN P14-02), kept in two places. The browser keeps a copy at once (so a reload loses nothing and the box works
 * when the server cannot be reached); the server keeps one a moment after typing stops, so another device shows it. Sending a message removes the server's
 * copy (the post route does it), so a sent message does not come back on another device.
 *
 * Which copy wins when a box opens is decided WITHOUT clocks. This device remembers, per box, the last state it knew the server to hold: the text and the
 * server's own `updatedAt` of it (the "synced version"), written only when the server confirmed a save or this device read the server's copy. From that:
 *   - the server's copy changed since (its `updatedAt` is not the synced one) and this device's text is still the synced text: the other device's copy wins;
 *   - the server's copy is as this device last knew it and the text here differs: the person typed here, so this text wins;
 *   - the server has nothing and the text here is still the synced text: it was sent or cleared elsewhere, so it is dropped (it must not come back);
 *   - this device never synced the box: the server's copy, if any, wins over an old local one; a local text alone is kept and saved.
 * Opening a box never counts as typing: only the person's own edits are ever saved over the server's copy.
 */

const DRAFT_PREFIX = 'manythreads.draft:';
const SYNC_PREFIX = 'manythreads.draft-sync:';

/** How long typing must pause before the server is told. */
export const SAVE_AFTER_MS = 1_500;

/** What this device last knew the server to hold for a box: that text and the server's `updatedAt` of it. */
export type SyncedDraft = { text: string; version: string };

export function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

export function readSynced(key: string): SyncedDraft | null {
  try {
    const raw = window.localStorage.getItem(SYNC_PREFIX + key);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<SyncedDraft> | null;
    return v && typeof v.text === 'string' && typeof v.version === 'string' ? { text: v.text, version: v.version } : null;
  } catch {
    return null;
  }
}

export function writeSynced(key: string, synced: SyncedDraft | null): void {
  try {
    if (synced === null) window.localStorage.removeItem(SYNC_PREFIX + key);
    else window.localStorage.setItem(SYNC_PREFIX + key, JSON.stringify(synced));
  } catch {
    /* storage can be blocked */
  }
}

/** The local copy of a box. An empty text removes it, and with it the memory of what the server held (a cleared or sent box starts over). */
export function writeDraft(key: string, text: string): void {
  try {
    if (text === '') {
      window.localStorage.removeItem(DRAFT_PREFIX + key);
      window.localStorage.removeItem(SYNC_PREFIX + key);
    } else {
      window.localStorage.setItem(DRAFT_PREFIX + key, text);
    }
  } catch {
    /* storage can be blocked: the draft then lives only in this tab */
  }
}

export type ChosenDraft = { text: string; from: 'local' | 'server' | 'cleared' };

/**
 * Which text a box starts with, from this device's copy, what this device last knew the server to hold, and the server's copy now (see the top of this file).
 * No clock is read: the server's own `updatedAt` is compared with the one the server gave this device earlier, never with the time on this device.
 */
export function chooseDraft(local: string, synced: SyncedDraft | null, server: { body: string; updatedAt: string } | null): ChosenDraft {
  if (server === null) {
    // sent or cleared on another device since this one last saw it: the old text must not come back
    if (synced !== null && local === synced.text) return { text: '', from: 'cleared' };
    return { text: local, from: 'local' };
  }
  if (local === '') return { text: server.body, from: 'server' };
  if (local === server.body) return { text: local, from: 'local' };
  // the server's copy is the one this device already knew, and the text here is different: typed here
  if (synced !== null && synced.version === server.updatedAt) return { text: local, from: 'local' };
  // the server's copy changed on another device since, or this device never synced the box: the server's copy wins. (Text typed here after the other
  // device saved, and not yet saved, is replaced; the person has been editing in two places at once.)
  return { text: server.body, from: 'server' };
}

type Box = { channelId: string; threadRootId: string | null; draftKey: string };

/**
 * Keeps the server's copy of a box in step. On opening a box it reads the person's drafts of the channel and decides (`chooseDraft`) what the box shows,
 * unless the person has typed in the meantime. After typing pauses for 1.5 s the text is saved (an empty text removes the server's copy); leaving the box
 * saves what was typed, but only what was typed since the box opened. A failure is silent: the browser's copy is always there. If the server says no (a guest,
 * a channel that cannot be posted in) the box stops asking.
 */
export function useServerDraft(box: Box, text: string, apply: (text: string) => void): () => void {
  const latest = useRef(text);
  latest.current = text;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  // what the server holds for the box now, as far as this page knows (`known`: the server has answered; until then it is unknown, not "nothing");
  // `openedWith` is the text the box started with, which is this device's old copy and not something the person typed
  const held = useRef<{ key: string; text: string | null; has: boolean; known: boolean; openedWith: string }>({ key: '', text: null, has: false, known: false, openedWith: '' });
  const off = useRef(false);

  const push = (target: Box, value: string): void => {
    if (off.current) return;
    const h = held.current;
    const same = h.key === target.draftKey;
    // before the server has answered, the text the box opened with is old and may be older than the server's copy: only the person's own typing is saved
    if (same && !h.known && value === h.openedWith) return;
    if (same && (h.text ?? '') === value && (value === '' ? !h.has : h.has)) return;
    const blank = value.trim() === '';
    if (blank && same && !h.has) return;
    held.current = { key: target.draftKey, text: blank ? '' : value, has: !blank, known: same ? h.known : false, openedWith: same ? h.openedWith : '' };
    const done = blank
      ? deleteDraft(target.channelId, target.threadRootId).then(() => writeSynced(target.draftKey, null))
      : value.length > DRAFT_MAX_CHARS
        ? Promise.resolve()
        : saveDraft(target.channelId, { body: value, ...(target.threadRootId ? { threadRootId: target.threadRootId } : {}) } as SaveDraftRequest).then((res) => {
            // the server's own time of this save is the version this device now knows
            if (res.draft) writeSynced(target.draftKey, { text: value, version: res.draft.updatedAt });
          });
    done.catch((err: unknown) => {
      if (isApiError(err) && (err.status === 403 || err.status === 404)) off.current = true;
      // anything else: the next change tries again
      held.current = { key: target.draftKey, text: null, has: true, known: held.current.known, openedWith: held.current.openedWith };
    });
  };

  // opening a box (and moving to another): read the server's copy; leaving a box: save what was typed
  useEffect(() => {
    const target = box;
    // what the box holds when it opens is this device's copy; anything else by the time the answer arrives is typing
    const atOpen = readDraft(target.draftKey);
    let live = true;
    held.current = { key: target.draftKey, text: null, has: false, known: false, openedWith: atOpen };
    if (!off.current) {
      fetchDrafts(target.channelId).then(
        (res) => {
          if (!live) return;
          const mine = res.items.find((d) => (d.threadRootId ?? null) === target.threadRootId) ?? null;
          held.current = { key: target.draftKey, text: mine?.body ?? null, has: mine !== null, known: true, openedWith: atOpen };
          // the person began typing while the answer was on its way: their text stays, and is saved over the server's by the next pause in typing
          if (latest.current !== atOpen) return;
          const chosen = chooseDraft(atOpen, readSynced(target.draftKey), mine);
          if (chosen.from === 'cleared') {
            writeDraft(target.draftKey, '');
            applyRef.current('');
            return;
          }
          if (chosen.from === 'server' && mine) {
            writeDraft(target.draftKey, mine.body);
            writeSynced(target.draftKey, { text: mine.body, version: mine.updatedAt });
            applyRef.current(mine.body);
            return;
          }
          if (mine && mine.body === chosen.text) writeSynced(target.draftKey, { text: mine.body, version: mine.updatedAt });
          // this device's text is the newer one, or the only one: the server gets it
          else if (chosen.text.trim() !== '') push(target, chosen.text);
        },
        (err: unknown) => {
          if (isApiError(err) && (err.status === 403 || err.status === 404)) off.current = true;
        },
      );
    }
    return () => {
      live = false;
      if (latest.current.trim() !== '' || held.current.has) push(target, latest.current);
    };
    // the box is its channel, its thread and the key the draft is stored under
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.channelId, box.threadRootId, box.draftKey]);

  // typing paused
  useEffect(() => {
    const t = setTimeout(() => push(box, text), SAVE_AFTER_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, box.channelId, box.threadRootId, box.draftKey]);

  // The text went out as a message. A screen that swaps the box for another the moment it is sent (Chat) unmounts this one before it renders the emptied
  // text, so "what was typed" is forgotten here, or leaving the box would save the sent message as a draft.
  return useCallback(() => {
    latest.current = '';
  }, []);
}

/** True when an error from a send says the writer must confirm `@channel` or `@here` for a big room. */
export const needsBroadcastConfirm = (err: unknown): boolean => isApiError(err) && err.code === 'broadcast_needs_confirmation';
