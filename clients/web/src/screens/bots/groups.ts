/*
 * The bot page's five groups (PLAN P21-17, plan F10-4). The fourteen sections of SPEC §7.2 are unchanged — each is still one part of
 * BOT.md with its own id — but the page shows them under five tabs, a group's sections stacked, so a person is not asked to pick
 * between fourteen words. Pure data and functions, so a test can hold the mapping (every section in exactly one group).
 */

export type BotGroupId = 'basics' | 'abilities' | 'safety' | 'where' | 'history';

export type BotGroup = { id: BotGroupId; label: string; sections: readonly string[] };

/** The groups in tab order; `sections` are the old tab ids in the order they are stacked. */
export const BOT_GROUPS: ReadonlyArray<BotGroup> = [
  { id: 'basics', label: 'Basics', sections: ['identity', 'behaviour', 'triggers', 'model'] },
  { id: 'abilities', label: 'What it can do', sections: ['capabilities', 'knowledge', 'memory', 'handover'] },
  { id: 'safety', label: 'Safety', sections: ['guard', 'approvals', 'contract'] },
  { id: 'where', label: 'Where it runs', sections: ['placement'] },
  { id: 'history', label: 'History', sections: ['evals', 'audit'] },
];

/** The group a section (an old tab id) lives in, or null for an id that is not a section. */
export const groupOfSection = (section: string): BotGroupId | null => BOT_GROUPS.find((g) => g.sections.includes(section))?.id ?? null;

export type BotView = { group: BotGroupId; /** The section to scroll to, when the link named one. */ section: string | null };

/**
 * What `?tab=` asks for: a group id opens that group; an old section id (`guard`, `placement`, …) opens its group and names the section to
 * scroll to; anything else — a missing or stale value — opens Basics rather than an empty page.
 */
export function viewOf(raw: string | null): BotView {
  if (raw !== null) {
    const group = BOT_GROUPS.find((g) => g.id === raw);
    if (group) return { group: group.id, section: null };
    const owner = groupOfSection(raw);
    if (owner !== null) return { group: owner, section: raw };
  }
  return { group: 'basics', section: null };
}
