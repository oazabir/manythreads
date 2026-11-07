import { cronToWords, localScheduleToCron, type LocalSchedule } from '../text/cron-words.ts';
import type { PersonalRoutineDraft } from '../api/scheduled-jobs/me.ts';
import type { RoutineOutputMode, RoutineSource } from './scheduled-job.ts';

// The Personal shelf (PLAN P20-14, P18-05, P18-06, P20-12): ready routines a person starts from in "New routine". A recipe here is not a bot and has no team: it is the sentence, the
// time of day, the prompt, the places to read and the file the output goes to. The person sees all of it as a proposal, may change anything and confirms; nothing is enabled by
// choosing one. The time is the person's own local time, turned into the stored UTC schedule with their time zone when the proposal is made.

export type RecipeDays = 'weekdays' | 'every_day' | 'friday' | 'monday';

export interface PersonalRoutineRecipe {
  id: string;
  name: string;
  /** One sentence a person reads on the card. */
  summary: string;
  /** The sentence this recipe stands for, shown in the words field when it is chosen. */
  sentence: string;
  /** Local time of day, `07:30`. */
  time: string;
  days: RecipeDays;
  prompt: string;
  sources: readonly RoutineSource[];
  /** A path in the person's Personal files. */
  outputPath: string;
  outputMode: RoutineOutputMode;
  /** The bot: the workspace Brain unless a recipe says otherwise. */
  botSlug: 'brain';
}

const ASK_FIRST =
  'Look only at what is in the places named below, and say where each thing came from. Write for me, in short plain sentences. If there is nothing to report, say so in one line.';

export const PERSONAL_ROUTINE_RECIPES: readonly PersonalRoutineRecipe[] = [
  {
    id: 'mail-summary',
    name: 'Daily mail summary',
    summary: 'Every weekday morning, a short list of my unread mail and which ones need a reply.',
    sentence: 'Every weekday at 7:30 summarise my unread mail and list what needs a reply',
    time: '07:30',
    days: 'weekdays',
    prompt: `Summarise my unread mail from the last day. First list the mails that need a reply from me, most urgent first, each with who wrote, what they ask and by when. Then one line for each of the rest. ${ASK_FIRST}`,
    sources: ['mail'],
    outputPath: 'Routines/daily-mail-summary/output.md',
    outputMode: 'replace',
    botSlug: 'brain',
  },
  {
    id: 'action-items',
    name: 'Keep my action items',
    summary: 'Gathers new actions from my mail, mentions, meeting notes and cards, and marks one done when its proof shows up. It never deletes one.',
    sentence: 'Every weekday at 8 keep my action items up to date from my mail, mentions, meetings and cards',
    time: '08:00',
    days: 'weekdays',
    prompt: [
      'Keep my action items up to date. My list is the file "Action items/action-items.md". Read it first, then look for new things I have to do and for proof that one is finished.',
      'Your reply is the whole new file, in this form, and nothing else:',
      '# Action items',
      '- [ ] What to do (owner: Name; due: 2026-11-20)',
      '  - source: where it came from, one line',
      '  - why: 6 Nov: what happened to it',
      'Rules. Keep every action that is in the file, in its words, and keep the ones that are done as they are. Add a new action only when a mail, a mention, a meeting note or a card clearly asks me to do something. Mark one done only when you can point to proof (the card is Done, the reply was sent, I ticked it), and then add a "why:" line saying what showed it. Never delete an action. ' +
        ASK_FIRST,
    ].join('\n'),
    sources: ['mail', 'mentions', 'threads', 'meetings', 'cards', 'action_items'],
    outputPath: 'Action items/action-items.md',
    outputMode: 'replace',
    botSlug: 'brain',
  },
  {
    id: 'meeting-prep',
    name: "Prepare for today's meetings",
    summary: 'Before the day starts, a short note for each meeting: who is coming, what was decided last time and what is open.',
    sentence: "Every weekday at 7:45 prepare me for today's meetings",
    time: '07:45',
    days: 'weekdays',
    prompt: `Look at my calendar for today. For each meeting write a short note: who is coming, what was decided or left open at the last meeting with the same people (from my meeting notes and my memory), and the one question I should be ready for. ${ASK_FIRST}`,
    sources: ['calendar', 'meetings', 'notes', 'memory'],
    outputPath: 'Routines/prepare-for-todays-meetings/output.md',
    outputMode: 'replace',
    botSlug: 'brain',
  },
  {
    id: 'weekly-recap',
    name: 'Weekly what-I-did',
    summary: 'On Friday afternoon, what I got done this week, with the cards, meetings and notes it came from.',
    sentence: 'Every Friday at 4pm write what I did this week',
    time: '16:00',
    days: 'friday',
    prompt: `Write what I did this week, from Monday. Group it by theme. Under each, list the cards I moved, the meetings I was in and the notes I wrote, with a link or a name for each. Do not invent work that I cannot be shown to have done. ${ASK_FIRST}`,
    sources: ['cards', 'meetings', 'mentions', 'notes'],
    outputPath: 'Routines/weekly-what-i-did/output.md',
    outputMode: 'replace',
    botSlug: 'brain',
  },
  {
    id: 'catch-me-up',
    name: 'Catch me up',
    summary: 'A morning brief: what mentions me, which threads wait on me, my approvals, my cards due, today’s meetings and my open actions.',
    sentence: 'Every weekday at 8 catch me up on what needs me today',
    time: '08:00',
    days: 'weekdays',
    prompt: `Write my morning brief. In this order: mentions of me since yesterday; threads that are waiting on me; approvals waiting for my yes; cards of mine that are due soon; today's meetings, each with a one-line prep note; my open action items. Put what is most urgent first in each part and leave out a part that is empty. If I was out of office, start with "What you missed" and cover those days. ${ASK_FIRST}`,
    sources: ['mentions', 'threads', 'approvals', 'cards', 'calendar', 'meetings', 'action_items'],
    outputPath: 'Routines/catch-me-up/output.md',
    outputMode: 'replace',
    botSlug: 'brain',
  },
  {
    id: 'follow-ups',
    name: 'Follow-ups',
    summary: 'You choose to turn this on. It lists questions asked of me that nobody answered, actions with my name from meetings and promised dates that have passed.',
    sentence: 'Every weekday at 9 and tell me which follow-ups I owe',
    time: '09:00',
    days: 'weekdays',
    prompt: `List the follow-ups I owe. Three parts. Questions put to me with no reply from me after one working day (who asked, where, since when). Actions with my name from my meeting notes that are still open. Dates I promised that have passed and are not done. For each, say how long it has been waiting. Read only what I can read myself: never anyone else's direct messages. Oldest first. ${ASK_FIRST}`,
    sources: ['mentions', 'threads', 'meetings', 'action_items'],
    outputPath: 'Routines/follow-ups/output.md',
    outputMode: 'replace',
    botSlug: 'brain',
  },
];

export const personalRecipeById = (id: string): PersonalRoutineRecipe | undefined => PERSONAL_ROUTINE_RECIPES.find((r) => r.id === id);

const DAYS: Record<RecipeDays, readonly number[] | null> = { weekdays: [1, 2, 3, 4, 5], every_day: null, friday: [5], monday: [1] };

/** A recipe as the proposal the New routine form shows, in the person's own time zone. The stored schedule is UTC. */
export function recipeToDraft(recipe: PersonalRoutineRecipe, timeZone: string, at: Date = new Date()): PersonalRoutineDraft {
  const local: LocalSchedule = { hour: Number(recipe.time.slice(0, 2)), minute: Number(recipe.time.slice(3, 5)), dow: DAYS[recipe.days] };
  const schedule = localScheduleToCron(local, timeZone, at);
  return {
    name: recipe.name,
    schedule,
    scheduleWords: cronToWords(schedule, timeZone, at),
    timeZone,
    prompt: recipe.prompt,
    sources: [...recipe.sources],
    outputPath: recipe.outputPath,
    outputMode: recipe.outputMode,
    botSlug: recipe.botSlug,
  };
}
