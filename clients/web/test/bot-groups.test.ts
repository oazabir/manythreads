import { describe, expect, it } from 'vitest';
import { BOT_GROUPS, groupOfSection, viewOf } from '../src/screens/bots/groups';
import { BOT_TABS } from '../src/screens/bots/store';

describe('the bot page groups', () => {
  it('has five groups in the planned order', () => {
    expect(BOT_GROUPS.map((g) => g.id)).toEqual(['basics', 'abilities', 'safety', 'where', 'history']);
    expect(BOT_GROUPS.map((g) => g.label)).toEqual(['Basics', 'What it can do', 'Safety', 'Where it runs', 'History']);
  });

  it('puts every old tab id in exactly one group, and no id that is not a tab', () => {
    const listed = BOT_GROUPS.flatMap((g) => g.sections);
    expect([...listed].sort()).toEqual(BOT_TABS.map((t) => t.id).sort());
    expect(new Set(listed).size).toBe(listed.length);
    for (const t of BOT_TABS) expect(BOT_GROUPS.filter((g) => g.sections.includes(t.id))).toHaveLength(1);
  });

  it('groups the sections as the plan says', () => {
    const of = (id: string): readonly string[] => BOT_GROUPS.find((g) => g.id === id)!.sections;
    expect(of('basics')).toEqual(['identity', 'behaviour', 'triggers', 'model']);
    expect(of('abilities')).toEqual(['capabilities', 'knowledge', 'memory', 'handover']);
    expect(of('safety')).toEqual(['guard', 'approvals', 'contract']);
    expect(of('where')).toEqual(['placement']);
    expect(of('history')).toEqual(['evals', 'audit']);
  });

  it('keeps group ids apart from section ids, so ?tab= is never ambiguous', () => {
    for (const g of BOT_GROUPS) expect(groupOfSection(g.id)).toBeNull();
  });

  it('opens the group of an old ?tab= id and names the section to scroll to', () => {
    expect(viewOf('guard')).toEqual({ group: 'safety', section: 'guard' });
    expect(viewOf('placement')).toEqual({ group: 'where', section: 'placement' });
    expect(viewOf('audit')).toEqual({ group: 'history', section: 'audit' });
    expect(viewOf('identity')).toEqual({ group: 'basics', section: 'identity' });
  });

  it('opens a group named by ?tab= without scrolling', () => {
    expect(viewOf('safety')).toEqual({ group: 'safety', section: null });
    expect(viewOf('history')).toEqual({ group: 'history', section: null });
  });

  it('falls back to Basics for a missing or unknown value', () => {
    expect(viewOf(null)).toEqual({ group: 'basics', section: null });
    expect(viewOf('')).toEqual({ group: 'basics', section: null });
    expect(viewOf('nonsense')).toEqual({ group: 'basics', section: null });
  });
});
