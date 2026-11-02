import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Moves focus to `ref` once the thing it points at has rendered: an effect keyed on `trigger`, which is the state that makes the element appear (null or false while it
 * is not there, a new value each time it should take focus again). A `setTimeout` right after setting that state can fire before React has rendered the element, so
 * the ref is still empty; an effect runs after the render that put the element in the page.
 */
export function useFocusWhen(ref: RefObject<HTMLElement | null>, trigger: unknown): void {
  useEffect(() => {
    if (trigger) ref.current?.focus();
  }, [ref, trigger]);
}
