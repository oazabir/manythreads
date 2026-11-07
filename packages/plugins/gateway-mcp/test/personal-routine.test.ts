import { describe, expect, it } from 'vitest';
import { forcePersonalNotes, isPersonalRoutineRun, personalRoutineHoldsWrite } from '../src/personal-routine.ts';

const mine = { trigger: 'routine', askerActorId: 'a1' } as const;
const teams = { trigger: 'routine', askerActorId: null } as const;
const chat = { trigger: 'mention', askerActorId: 'a1' } as const;

describe('the guards of a personal routine', () => {
  it('knows its runs: the routine trigger with a person asking', () => {
    expect(isPersonalRoutineRun(mine)).toBe(true);
    expect(isPersonalRoutineRun(teams)).toBe(false);
    expect(isPersonalRoutineRun(chat)).toBe(false);
  });

  it('holds every write but the notes for the owner', () => {
    expect(personalRoutineHoldsWrite(mine, 'tasks.create', 'write')).toBe(true);
    expect(personalRoutineHoldsWrite(mine, 'memory.write', 'write')).toBe(false);
    expect(personalRoutineHoldsWrite(mine, 'messages.search', 'read')).toBe(false);
    expect(personalRoutineHoldsWrite(teams, 'tasks.create', 'write')).toBe(false);
  });

  it('files the notes of a personal routine in its owner\'s own memory, whatever target the model sends', () => {
    const note = { path: 'memory/facts/a.md', type: 'fact', body: 'x' };
    expect(forcePersonalNotes(mine, 'memory.write', note)).toEqual({ ...note, target: 'personal' });
    expect(forcePersonalNotes(mine, 'memory.write', { ...note, target: 'team' })).toEqual({ ...note, target: 'personal' });
    // nothing else changes: another tool, a team's schedule, a chat
    expect(forcePersonalNotes(mine, 'tasks.create', note)).toBe(note);
    expect(forcePersonalNotes(teams, 'memory.write', note)).toBe(note);
    expect(forcePersonalNotes(chat, 'memory.write', note)).toBe(note);
  });
});
