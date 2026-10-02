import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { pickViewerContribution, type ViewerContribution, type ViewerSubject } from '@manythreads/shared';
import type { ViewerModule, ViewerProps } from './types';

/** A `provider.viewer` contribution on the client: the declarative part plus how to load the component (a dynamic import, so heavy viewers stay out of the main bundle). */
export type ViewerDef = ViewerContribution & {
  load: () => Promise<ViewerModule>;
};

export type ViewerRegistry = {
  /** A later registration of the same id replaces the earlier one in place. */
  register(def: ViewerDef): void;
  get(id: string): ViewerDef | undefined;
  list(): ViewerDef[];
  /** The viewer that opens the subject (highest priority, later wins ties); the fallback card when nothing else claims it. */
  pick(subject: ViewerSubject): ViewerDef | undefined;
  /** The (cached) lazy component of a viewer. */
  component(def: ViewerDef): LazyExoticComponent<ComponentType<ViewerProps>>;
};

export function createViewerRegistry(): ViewerRegistry {
  const defs = new Map<string, ViewerDef>();
  const lazies = new WeakMap<ViewerDef, LazyExoticComponent<ComponentType<ViewerProps>>>();
  return {
    register: (def) => void defs.set(def.id, def),
    get: (id) => defs.get(id),
    list: () => [...defs.values()],
    pick: (subject) => pickViewerContribution([...defs.values()], subject),
    component: (def) => {
      let c = lazies.get(def);
      if (!c) {
        c = lazy(def.load);
        lazies.set(def, c);
      }
      return c;
    },
  };
}

/** The app's registry; the built-in viewers are registered in `viewers/builtins.ts`. */
export const viewerRegistry: ViewerRegistry = createViewerRegistry();
export const registerViewer = viewerRegistry.register;
