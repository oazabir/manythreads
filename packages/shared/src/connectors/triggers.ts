import type { ConnectorEntry } from './catalog.ts';

// Which triggers of which connector are switched on (PLAN Bundle D, decision D35). A connector's triggers are listed in its entry with `available: false`; the
// package that builds a trigger lists it HERE (`connector id` -> `trigger ids`), so the catalog files are not edited by two packages at once. catalog.ts applies this
// list to every entry; an id that names no trigger of the entry changes nothing (the catalog test refuses it).

// P16-10 (work-app endpoints): a lead makes an address for the app at the channel's Integrations screen, and a bot's `webhook` trigger names it. These are the triggers that
// start that way. Freshdesk and HubSpot have no address kind of their own yet (a HubSpot ticket arrives through its `hubspot` endpoint, which no catalog trigger names).
export const AVAILABLE_TRIGGERS: Readonly<Record<string, readonly string[]>> = {
  jira: ['issue_changed'],
  linear: ['issue_changed'],
  asana: ['task_changed'],
  zendesk: ['ticket_created'],
  intercom: ['conversation_created'],
  github: ['issue_opened', 'pull_request_changed'],
  gitlab: ['issue_opened'],
};

/** The entry with the triggers of `AVAILABLE_TRIGGERS` turned on. */
export const withTriggerAvailability = (entry: ConnectorEntry): ConnectorEntry => {
  const on = AVAILABLE_TRIGGERS[entry.id];
  if (!on || on.length === 0) return entry;
  return { ...entry, triggers: entry.triggers.map((t) => (on.includes(t.id) ? { ...t, available: true } : t)) };
};
