// Which Hermes tools a bot gets: the definition's grant, written into the profile (SPEC §7.2 `capabilities.runtime`, PLAN P6-06).
//
// A Hermes run without a tool list gets every tool the CLI has — a shell, file writes, a browser, scheduled jobs, sub-agents — whatever
// the BOT.md said. `capabilities.runtime` is the definition's list of what the bot's *process* may do (`shell`, `files`, `git`,
// `browser`, …), so the platform turns it into the profile's tool list and refuses the rest, in the profile and not in a prompt:
//
//  * `platform_toolsets.cli` names the toolsets that are on. Measured on Hermes 0.21.5 (docs/plugins/runners.md): an **empty list is not
//    "none"** — Hermes falls back to its full default — so a bot with no grant is given `todo` (an in-memory checklist that touches
//    nothing), never `[]`.
//  * `agent.disabled_toolsets` is subtracted last and wins over everything, so every powerful toolset the bot was not granted is named
//    there too. A bot that talks the platform's MCP endpoint keeps its MCP tools either way: those are the capability broker's to grant.
//
// `git` has no toolset of its own: it is a program in the shell, so a bot that can use `git` but not `shell` still has no terminal.

/** The toolset a runtime grant turns on. A grant that is not here (a typo, a slug for a later runtime) turns nothing on. */
export const RUNTIME_GRANT_TOOLSETS: Readonly<Record<string, string>> = {
  shell: 'terminal',
  files: 'file',
  browser: 'browser',
  web: 'web',
  vision: 'vision',
};

/** What a bot with no grant gets: Hermes treats an empty list as "the default", which is everything. */
const HARMLESS_TOOLSET = 'todo';

/**
 * Every toolset that can act outside the conversation (run a command, write a file, browse, schedule, spawn another agent, remember
 * across runs, reach a device or a third-party service). Anything here that a grant does not turn on is disabled by name.
 */
export const GUARDED_TOOLSETS: readonly string[] = [
  'terminal',
  'file',
  'browser',
  'code_execution',
  'delegation',
  'cronjob',
  'computer_use',
  'web',
  'search',
  'x_search',
  'vision',
  'video',
  'image_gen',
  'video_gen',
  'tts',
  'memory',
  'session_search',
  'skills',
  'kanban',
  'connections',
  'project',
  'setup',
  'clarify',
  'homeassistant',
  'spotify',
];

export interface HermesToolsets {
  /** `platform_toolsets.cli`: never empty. */
  enabled: string[];
  /** `agent.disabled_toolsets`: the guarded toolsets the bot was not granted. */
  disabled: string[];
}

/** The toolsets for a definition's `capabilities.runtime`. Pure: the same list gives the same answer, in a stable order. */
export function hermesToolsets(runtimeGrants: readonly string[] | undefined): HermesToolsets {
  const on = new Set<string>();
  for (const grant of runtimeGrants ?? []) {
    const toolset = RUNTIME_GRANT_TOOLSETS[grant];
    if (toolset !== undefined) on.add(toolset);
  }
  const enabled = on.size > 0 ? GUARDED_TOOLSETS.filter((name) => on.has(name)) : [HARMLESS_TOOLSET];
  return { enabled, disabled: GUARDED_TOOLSETS.filter((name) => !on.has(name)) };
}
