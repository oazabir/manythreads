/** The Projects page and the sidebar's Projects section show the same list: this tells the section to ask again after the page changed something. */
const EVENT = 'manythreads:projects-changed';

export const announceProjectsChanged = (): void => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
};

/** Calls `fn` whenever the page changed the projects; returns what stops listening. */
export function onProjectsChanged(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
