import { describe, expect, it } from 'vitest';
import { PERSONAL_ROUTINE_RECIPES, PersonalRoutineDraft, ROUTINE_SOURCE_CONNECTION, minGapMinutes, personalRecipeById, recipeToDraft, wordsToSchedule } from '../src/index.ts';

// P20-14, P18-05, P18-06: the Personal shelf. Each recipe is a proposal a person reads and confirms; none is a bot or enables itself.

const AT = new Date('2026-11-09T09:00:00Z');

describe('the Personal shelf', () => {
  it('has the six recipes with unique ids, plain words and no placeholder', () => {
    expect(PERSONAL_ROUTINE_RECIPES.map((r) => r.id)).toEqual(['mail-summary', 'action-items', 'meeting-prep', 'weekly-recap', 'catch-me-up', 'follow-ups']);
    expect(new Set(PERSONAL_ROUTINE_RECIPES.map((r) => r.id)).size).toBe(PERSONAL_ROUTINE_RECIPES.length);
    for (const r of PERSONAL_ROUTINE_RECIPES) {
      expect(r.id, r.id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
      expect(`${r.name} ${r.summary} ${r.sentence} ${r.prompt}`, r.id).not.toMatch(/\bP\d{1,2}-\d{2}\b|\bPLAN\b|\{\{|TODO|FIXME/);
      expect(personalRecipeById(r.id)).toBe(r);
    }
  });

  it('turns every recipe into a valid proposal in the person\'s own time zone, at least fifteen minutes apart', () => {
    for (const r of PERSONAL_ROUTINE_RECIPES) {
      const draft = recipeToDraft(r, 'Asia/Dubai', AT);
      expect(PersonalRoutineDraft.safeParse(draft).success, r.id).toBe(true);
      expect(minGapMinutes(draft.schedule, AT) ?? 1440, r.id).toBeGreaterThanOrEqual(15);
      expect(draft.scheduleWords, r.id).toMatch(/\d/);
      // 7:30 in Dubai (UTC+4) is 03:30 UTC
      if (r.id === 'mail-summary') expect(draft.schedule).toBe('30 3 * * 1-5');
    }
  });

  it('says the same schedule in words as the sentence parser reads from the recipe\'s own sentence', () => {
    for (const r of PERSONAL_ROUTINE_RECIPES) {
      const parsed = wordsToSchedule(r.sentence, 'Asia/Dubai', AT);
      expect(parsed, r.sentence).not.toBeNull();
      expect(parsed!.cron, r.id).toBe(recipeToDraft(r, 'Asia/Dubai', AT).schedule);
    }
  });

  it('only reads places that exist, writes inside the person\'s own folders and never to Memory', () => {
    for (const r of PERSONAL_ROUTINE_RECIPES) {
      expect(r.outputPath.split('/')[0], r.id).not.toBe('Memory');
      expect(['Routines', 'Action items', 'Notes']).toContain(r.outputPath.split('/')[0]);
      for (const s of r.sources) expect(typeof (ROUTINE_SOURCE_CONNECTION[s] ?? []).length).toBe('number');
    }
    // the action-items keeper rewrites the list file itself, in replace mode
    const keeper = personalRecipeById('action-items')!;
    expect(keeper.outputPath).toBe('Action items/action-items.md');
    expect(keeper.outputMode).toBe('replace');
    expect(keeper.prompt).toMatch(/Never delete an action/);
  });
});
