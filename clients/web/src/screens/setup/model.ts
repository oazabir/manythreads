import { GRADES, isGap, type Grade, type GradedRequirement, type SetupProposalRef, type SetupQuestion, type SetupSession } from '@manythreads/shared';

/*
 * The pure parts of the "Add a bot" screen (PLAN P7-04): which step a conversation is at, how the grades read, whether the answers are complete, in what order the proposals are approved.
 * No React here, so the tests can run them without a browser.
 */

export type Step = 'brief' | 'working' | 'asking' | 'proposed' | 'failed' | 'cancelled';

export const stepOf = (session: Pick<SetupSession, 'status'> | null): Step => (session === null ? 'brief' : session.status);

/** How often to read a working conversation again: quick at first, slower the longer it takes. */
export function pollDelay(attempt: number): number {
  if (attempt < 10) return 1200;
  if (attempt < 30) return 2500;
  return 5000;
}

export const GRADE_WORDS: Record<Grade, string> = {
  covered: 'Covered',
  grantable: 'Needs approval',
  missing: 'Missing',
  blocked: 'Not allowed',
  unclear: 'Unclear',
};

/** One short line under the heading of the feasibility list: how many things need a decision. */
export function feasibilitySummary(requirements: ReadonlyArray<Pick<GradedRequirement, 'grade'>>): string {
  const total = requirements.length;
  if (total === 0) return 'Nothing listed yet.';
  const gaps = requirements.filter((r) => isGap(r.grade)).length;
  const grantable = requirements.filter((r) => r.grade === 'grantable').length;
  const parts = [`${total} ${total === 1 ? 'thing' : 'things'} asked for`];
  if (gaps > 0) parts.push(`${gaps} open`);
  if (grantable > 0) parts.push(`${grantable} to approve`);
  return parts.join(' · ');
}

/** The grades in the order the plan names them, so the list reads from "can do" to "cannot". */
export const sortedByGrade = <T extends Pick<GradedRequirement, 'grade'>>(requirements: ReadonlyArray<T>): T[] =>
  [...requirements].sort((a, b) => GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade));

export type Draft = Readonly<Record<string, string>>;

/** The answers to send: one for every open question, in the order of the questions. `null` while any is empty. */
export function answersFrom(questions: ReadonlyArray<Pick<SetupQuestion, 'id'>>, draft: Draft): Array<{ questionId: string; text: string }> | null {
  const out: Array<{ questionId: string; text: string }> = [];
  for (const q of questions) {
    const text = (draft[q.id] ?? '').trim();
    if (text === '') return null;
    out.push({ questionId: q.id, text });
  }
  return out.length > 0 ? out : null;
}

export const answeredCount = (questions: ReadonlyArray<Pick<SetupQuestion, 'id'>>, draft: Draft): number => questions.filter((q) => (draft[q.id] ?? '').trim() !== '').length;

/** What the brief box needs before "Let it explore" works: a sentence or two. */
export const BRIEF_MIN = 8;
export const briefReady = (brief: string): boolean => brief.trim().length >= BRIEF_MIN;

/** A bot that ships in a team template, offered as a starting point for the brief. */
export interface Example {
  readonly key: string;
  /** The name of the first template that ships it (shown in the card's tooltip). */
  readonly template: string;
  /** The id of that template, and of every other template that ships the same bot. */
  readonly templateId: string;
  readonly templateIds: ReadonlyArray<string>;
  readonly name: string;
  readonly role: string;
}

/** The bots of the team templates the person can start from. Brain is left out (every team already has one); a bot that two templates share is listed once, under the first. */
export function examplesFrom(templates: ReadonlyArray<{ id?: string; name: string; bots: ReadonlyArray<{ slug: string; name: string; role: string }> }>): Example[] {
  const byKey = new Map<string, { example: Example; ids: string[] }>();
  for (const t of templates) {
    const id = t.id ?? '';
    for (const b of t.bots) {
      if (b.slug === 'brain' || b.role.trim() === '') continue;
      const seen = byKey.get(b.slug);
      if (seen) {
        if (id !== '' && !seen.ids.includes(id)) seen.ids.push(id);
        continue;
      }
      byKey.set(b.slug, { example: { key: b.slug, template: t.name, templateId: id, templateIds: [], name: b.name, role: b.role.trim() }, ids: id === '' ? [] : [id] });
    }
  }
  return [...byKey.values()].map(({ example, ids }) => ({ ...example, templateIds: ids }));
}

/** How many example cards the screen shows before "See all". */
export const EXAMPLE_CARDS = 6;

/**
 * The examples in the order this team should see them: the bots of the team's own template first, then the rest in template order. A bot the team already has is left out.
 * The sort is stable, so inside each group the templates' own order holds.
 */
export function rankExamples(
  examples: ReadonlyArray<Example>,
  { teamTemplate, existingSlugs }: { teamTemplate: string | null; existingSlugs: ReadonlyArray<string> },
): Example[] {
  const have = new Set(existingSlugs);
  const own = (e: Example): boolean => teamTemplate !== null && e.templateIds.includes(teamTemplate);
  return examples.filter((e) => !have.has(e.key)).sort((a, b) => Number(own(b)) - Number(own(a)));
}

/** The examples whose name, one-line description or template mention every word typed in the filter box of "See all". */
export function filterExamples(examples: ReadonlyArray<Example>, query: string): Example[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [...examples];
  return examples.filter((e) => {
    const hay = `${e.name} ${e.role} ${e.template}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The brief a picked example starts the box with: what the bot is for, in the template's own words, for the person to change. */
export const briefFromExample = (e: Pick<Example, 'name' | 'role'>): string => `Like the ${e.name} bot. ${/[.!?]$/.test(e.role) ? e.role : `${e.role}.`}`;

/**
 * The order the proposals are approved in: the team file and the skills first, the bot last, so that when the bot's definition is read everything it names is already there.
 * A conversation that proposed only the bot has one step.
 */
export function approvalOrder<T extends Pick<SetupProposalRef, 'role'>>(refs: ReadonlyArray<T>): T[] {
  const rank = { team: 0, skill: 1, bot: 2 } as const;
  return [...refs].sort((a, b) => rank[a.role] - rank[b.role]);
}

/** The slug of the bot the conversation proposed, from the path of its definition (`bots/<slug>/BOT.md`). */
export function botSlugOf(refs: ReadonlyArray<Pick<SetupProposalRef, 'role' | 'path'>>): string | null {
  const bot = refs.find((r) => r.role === 'bot');
  const m = bot ? /^bots\/([^/]+)\/BOT\.md$/.exec(bot.path) : null;
  return m ? (m[1] as string) : null;
}

/** The sentence under a working conversation: what the helper is doing while the person waits. */
export function workingLine(session: Pick<SetupSession, 'inventory' | 'answers'>): string {
  if (session.answers.length > 0) return 'Thinking about your answers…';
  if (session.inventory === null) return 'Looking at what this team has…';
  return 'Working out what the bot needs…';
}

/**
 * A failed read that repeating cannot fix: the conversation is gone, is not the person's, or their sign-in ended (any 4xx but "too soon" and "too many"). The screen stops reading and
 * offers a fresh start; a network error or a 5xx is tried again, slowly.
 */
export const stopsPolling = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 429;

/** What starts a bot, in the words a person uses. */
export const TRIGGER_WORDS: Record<string, string> = {
  conversation: 'a chat with the bot',
  mention: 'being @mentioned',
  channel_message: 'a message in a channel',
  task_assigned: 'a task given to it',
  routine: 'a schedule',
  inbox: 'an email arriving',
  webhook: 'an event in another app',
};

/** The safety setting every bot of a team starts from, in plain words. */
export const GUARD_WORDS: Record<string, string> = {
  standard: 'Standard',
  'customer-facing': 'Customer-facing: extra checks on what the bot sends',
  'strict-egress': 'Strict: extra checks on what leaves the workspace',
  'air-gapped': 'Air-gapped: only the local model',
};

/** The shell, files and browser a bot may be given, in words. */
export const RUNTIME_WORDS: Record<string, string> = { shell: 'commands (shell)', files: 'files', browser: 'a web browser' };

/** The line a screen reader hears when the page changes under it (the visible change is a new card; this says so). */
export function announcement(step: Step, session: Pick<SetupSession, 'questions'> | null): string {
  switch (step) {
    case 'working':
      return 'The helper is working.';
    case 'asking': {
      const n = session?.questions.length ?? 0;
      return `${n} ${n === 1 ? 'question' : 'questions'} for you. Answer every one, then send.`;
    }
    case 'proposed':
      return 'The proposal is ready to review.';
    case 'failed':
      return 'The helper could not finish.';
    case 'cancelled':
      return 'Stopped. Nothing was changed.';
    default:
      return '';
  }
}

/** The heading each step moves keyboard focus to when it appears (the proposal moves its own focus once its files are loaded). */
export const FOCUS_ID: Partial<Record<Step, string>> = { working: 'su-work-h', asking: 'su-q-h', failed: 'su-end-h', cancelled: 'su-end-h' };
