import { useCallback, useEffect, useRef, useState } from 'react';
import type { Appearance } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { useSession, useSessionState } from '../app/session';
import { saveMyAppearance } from '../screens/account/appearanceApi';
import { applyAppearance, previewAppearance } from './appearance';

/**
 * Picking a look, in one place (P30-01): Settings → Appearance and the account menu's Appearance submenu both call this, so a choice is drawn, kept in the
 * session, saved with the person and put back on a failed save the same way in both.
 *
 * `pick` draws the change at once (the page answers the click), puts it in the session so a later page reads it, then saves it. When the server stores
 * something else the stored value is drawn; when the save fails the look from before the click comes back and `error` says so. `preview` draws a look
 * without keeping it anywhere (no session, no saved copy, no request); `endPreview` draws the saved look again.
 */
export function useAppearanceChoice(opts: { onSaved?: () => void } = {}): {
  current: Appearance;
  error: string | null;
  pick: (change: Partial<Appearance>) => Promise<void>;
  preview: (change: Partial<Appearance>) => void;
  endPreview: () => void;
} {
  const session = useSession();
  const { setSession } = useSessionState();
  const current = session.person.appearance;
  const [error, setError] = useState<string | null>(null);
  // the newest session and the newest click: a handler that runs after an await must not write over what a later render or click set
  const live = useRef({ session, current });
  live.current = { session, current };
  const newest = useRef(0);
  const previewing = useRef(false);
  const onSaved = useRef(opts.onSaved);
  onSaved.current = opts.onSaved;

  const keep = useCallback(
    (a: Appearance) => {
      setSession({ ...live.current.session, person: { ...live.current.session.person, appearance: a } });
    },
    [setSession],
  );

  const pick = useCallback(
    async (change: Partial<Appearance>): Promise<void> => {
      const before = live.current.current;
      const next: Appearance = { ...before, ...change };
      const mine = ++newest.current;
      previewing.current = false;
      setError(null);
      applyAppearance(next);
      keep(next);
      try {
        const stored = await saveMyAppearance(change);
        if (stored.theme !== next.theme || stored.density !== next.density || stored.palette !== next.palette) {
          applyAppearance(stored);
          keep(stored);
        }
        onSaved.current?.();
      } catch (err) {
        if (mine !== newest.current) return; // a later click owns the page now
        applyAppearance(before);
        keep(before);
        setError(isApiError(err) ? err.message : 'Could not save. Try again.');
      }
    },
    [keep],
  );

  const preview = useCallback((change: Partial<Appearance>): void => {
    previewing.current = true;
    previewAppearance({ ...live.current.current, ...change });
  }, []);

  const endPreview = useCallback((): void => {
    if (!previewing.current) return;
    previewing.current = false;
    previewAppearance(live.current.current);
  }, []);

  // leaving while a preview is drawn (the menu closes) puts the saved look back
  useEffect(() => endPreview, [endPreview]);

  return { current, error, pick, preview, endPreview };
}
