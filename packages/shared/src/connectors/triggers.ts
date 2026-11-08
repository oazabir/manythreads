import type { ConnectorEntry } from './catalog.ts';

// Which triggers of which connector are switched on (PLAN Bundle D, decision D35). A connector's triggers are listed in its entry with `available: false`; the
// package that builds a trigger lists it HERE (`connector id` -> `trigger ids`), so the catalog files are not edited by two packages at once. catalog.ts applies this
// list to every entry; an id that names no trigger of the entry changes nothing (the catalog test refuses it).

export const AVAILABLE_TRIGGERS: Readonly<Record<string, readonly string[]>> = {};

/** The entry with the triggers of `AVAILABLE_TRIGGERS` turned on. */
export const withTriggerAvailability = (entry: ConnectorEntry): ConnectorEntry => {
  const on = AVAILABLE_TRIGGERS[entry.id];
  if (!on || on.length === 0) return entry;
  return { ...entry, triggers: entry.triggers.map((t) => (on.includes(t.id) ? { ...t, available: true } : t)) };
};
