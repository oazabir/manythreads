import type { ComponentType } from 'react';
import type { PanelEntry } from './stack';

/** What the panel needs to show one kind of entry. Plugins register their own (`file:<path>` in the files plugin). */
export type PanelTypeDef = {
  /** The `<type>` of `?panel=<type>:<id>`: lowercase letters, digits and dashes. */
  type: string;
  /** Header text while the entry has not told us more. */
  label: string;
  Component: ComponentType<{ entry: PanelEntry }>;
};

export type PanelRegistry = {
  /** A later registration of the same type replaces the earlier one (a plugin swapping a placeholder). */
  register(def: PanelTypeDef): void;
  get(type: string): PanelTypeDef | undefined;
  types(): string[];
};

export function createPanelRegistry(): PanelRegistry {
  const defs = new Map<string, PanelTypeDef>();
  return {
    register: (def) => void defs.set(def.type, def),
    get: (type) => defs.get(type),
    types: () => [...defs.keys()],
  };
}

/** The app's registry. Built-in types are registered in `builtins.tsx`. */
export const panelRegistry: PanelRegistry = createPanelRegistry();
export const registerPanelType = panelRegistry.register;
