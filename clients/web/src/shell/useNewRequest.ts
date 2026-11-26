import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { NEW_PARAM } from './newMenu';

/**
 * The one-shot "start something new" request in an address (`/t/eng/files?new=file`), which the "New" menu in the sidebar sends (P38-07).
 *
 * `takeNewRequest` is the pure half: the value the address asks for and the query string with the request removed. It always removes the parameter, even for a
 * value the screen does not know, so a stale `?new=` never stays in the address.
 */
export function takeNewRequest<K extends string>(search: string, accepts: readonly K[]): { present: boolean; kind: K | null; rest: string } {
  const q = new URLSearchParams(search);
  const value = q.get(NEW_PARAM);
  if (value === null) return { present: false, kind: null, rest: search };
  q.delete(NEW_PARAM);
  const rest = q.toString();
  return { present: true, kind: accepts.find((k) => k === value) ?? null, rest: rest === '' ? '' : `?${rest}` };
}

/**
 * Read the request once when the screen arrives (or when the menu is used again on the same screen) and take it out of the address with a replace, so Back and a
 * reload do not start it a second time. `kind` is the request until the screen answers it: a screen that has to wait for its data keeps reading `kind` and
 * calls `done()` when it has opened its dialog or put the cursor in its box; one that can answer at once calls `done()` in the same effect.
 */
export function useNewRequest<K extends string>(accepts: readonly K[]): { kind: K | null; done: () => void } {
  const loc = useLocation();
  const navigate = useNavigate();
  const [kind, setKind] = useState<K | null>(null);
  // the address entry already handled: the same entry is never taken twice (React runs effects twice in development)
  const handled = useRef<string | null>(null);
  const acceptsKey = accepts.join('\n');
  useEffect(() => {
    const taken = takeNewRequest(loc.search, acceptsKey === '' ? [] : (acceptsKey.split('\n') as K[]));
    if (!taken.present || handled.current === loc.key) return;
    handled.current = loc.key;
    setKind(taken.kind);
    void navigate({ pathname: loc.pathname, search: taken.rest, hash: loc.hash }, { replace: true, state: loc.state as unknown });
  }, [loc.key, loc.pathname, loc.search, loc.hash, loc.state, acceptsKey, navigate]);
  const done = useCallback(() => setKind(null), []);
  return { kind, done };
}

/**
 * Wait for something a request needs to be on the screen (a box that mounts after its data arrives), looking once a frame for up to three seconds, then hand it over.
 * `then` gets the element, or null when it never came, so the caller can still finish the request. Returns what stops the wait (for an effect's cleanup).
 */
export function whenThere(find: () => HTMLElement | null, then: (el: HTMLElement | null) => void, frames = 180): () => void {
  let tries = 0;
  let frame = 0;
  const look = (): void => {
    const el = find();
    if (el || ++tries > frames) {
      then(el);
      return;
    }
    frame = requestAnimationFrame(look);
  };
  frame = requestAnimationFrame(look);
  return () => cancelAnimationFrame(frame);
}
