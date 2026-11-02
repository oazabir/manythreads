import { LlmGuardPreset } from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';

// What a team's TEAM.md says its bots may be given by default. Two optional keys under `defaults:` in the frontmatter (docs/plugins/workshop.md):
//   botRuntime:  [shell, files, browser]   the runtime tools a bot of this team may be given. Left out: none.
//   guardPreset: standard                  the weakest guard preset a bot of this team may use (standard, customer-facing, strict-egress, air-gapped). Left out: standard.
// A key that is LEFT OUT means the documented default above. A key that is PRESENT but cannot be read (a front block that is not YAML, `defaults` that is not a mapping, a preset that is not
// one of the four, a runtime list that is not a list) is NOT "nothing said": it is read as the strictest answer (no runtime tools, the air-gapped guard) and the result says it was unreadable,
// so `propose_config` refuses with a plain sentence instead of letting a typo loosen the team's rules. It never throws.

/** The runtime tools a team can allow. Anything else in the list is ignored. */
export const RUNTIME_TOOLS = ['shell', 'files', 'browser'] as const;

export interface TeamDefaults {
  runtimeAllowed: string[];
  guardPreset: LlmGuardPreset;
  /** True when something under `defaults:` (or the front block itself) was there but could not be read; the values above are then the strictest. */
  unreadable: boolean;
}

/** No TEAM.md, or one that says nothing about defaults: the documented defaults. */
export const NO_TEAM_DEFAULTS: TeamDefaults = { runtimeAllowed: [], guardPreset: 'standard', unreadable: false };

/** A TEAM.md whose defaults cannot be read: nothing allowed, the strictest guard. */
export const UNREADABLE_TEAM_DEFAULTS: TeamDefaults = { runtimeAllowed: [], guardPreset: 'air-gapped', unreadable: true };

/** The plain sentence the helper and the person get while the defaults cannot be read. */
export const UNREADABLE_DEFAULTS_MESSAGE =
  "The defaults in TEAM.md (under \"defaults:\") can't be read, so the platform can't tell what a bot of this team may be given and treats it as the strictest. A team lead needs to fix that block in TEAM.md first.";

/** The frontmatter block of a Markdown file, or null. */
function frontmatterOf(text: string): string | null {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? (m[1] as string) : null;
}

export function readTeamDefaults(teamMd: string | null): TeamDefaults {
  if (teamMd === null) return NO_TEAM_DEFAULTS;
  const block = frontmatterOf(teamMd);
  if (block === null) return NO_TEAM_DEFAULTS;
  let doc: unknown;
  try {
    doc = parseYaml(block, { maxAliasCount: 20 });
  } catch {
    return UNREADABLE_TEAM_DEFAULTS;
  }
  // an empty block (or one that is only comments) says nothing; any other shape than a mapping is a broken file
  if (doc === null || doc === undefined) return NO_TEAM_DEFAULTS;
  if (!isRecord(doc)) return UNREADABLE_TEAM_DEFAULTS;
  const raw = doc['defaults'];
  if (raw === undefined || raw === null) return NO_TEAM_DEFAULTS;
  if (!isRecord(raw)) return UNREADABLE_TEAM_DEFAULTS;

  let unreadable = false;
  let runtimeAllowed: string[] = [];
  if (raw['botRuntime'] !== undefined && raw['botRuntime'] !== null) {
    if (Array.isArray(raw['botRuntime'])) runtimeAllowed = RUNTIME_TOOLS.filter((tool) => (raw['botRuntime'] as unknown[]).includes(tool));
    else unreadable = true;
  }
  let guardPreset: LlmGuardPreset = 'standard';
  if (raw['guardPreset'] !== undefined && raw['guardPreset'] !== null) {
    const preset = LlmGuardPreset.safeParse(raw['guardPreset']);
    if (preset.success) guardPreset = preset.data;
    else unreadable = true;
  }
  return unreadable ? UNREADABLE_TEAM_DEFAULTS : { runtimeAllowed, guardPreset, unreadable: false };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * May a bot use `preset` when its team's default is `teamDefault`? Under `standard` any preset is fine. Under another default the bot must use that same preset or
 * `air-gapped` (which allows only the local model and so is stricter than all of them): `customer-facing` and `strict-egress` guard different things, so neither stands for the other.
 */
export function presetAllowed(teamDefault: LlmGuardPreset, preset: LlmGuardPreset): boolean {
  return teamDefault === 'standard' || preset === teamDefault || preset === 'air-gapped';
}
