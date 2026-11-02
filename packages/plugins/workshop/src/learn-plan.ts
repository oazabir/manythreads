import { botEvalSetPath, parseBotMd, type BotFrontmatter, type WorkshopProposalRole } from '@manythreads/shared';
import {
  LESSON_EVAL_SET,
  LESSON_MAX_CHARS,
  asksForRule,
  compactLessons,
  contradiction,
  earlierSameLessons,
  evalCaseFor,
  hasCaseForLesson,
  lessonLine,
  lessonsPath,
  lineCount,
  maxLinesOf,
  rulesOf,
  withEvalCase,
  withEvalsBlock,
  withLesson,
  withRule,
  type GateContext,
} from './learning.ts';

// What a batch of corrections comes to (PLAN P7-06): the new text of every file that changes and, for each correction, what was decided. A pure function over the current texts, so the
// whole policy (what repeats, what is refused, when the notes are too long) is tested without a database, and the same inputs always give the same files. `tools.ts` reads the files, calls
// this, and files the result as proposals in one transaction.

export interface CorrectionArg {
  lesson: string;
  /** What to ask the bot so the lesson shows. */
  question: string;
  mustMention?: readonly string[] | undefined;
  mustNotMention?: readonly string[] | undefined;
  mustCall?: readonly string[] | undefined;
  mustNotCall?: readonly string[] | undefined;
  /** The wording of the rule, when the lesson should also be a rule. The lesson itself is used when this is left out. */
  rule?: string | undefined;
}

export interface PlanInput {
  slug: string;
  botName: string;
  today: string;
  /** The person's latest message, verbatim: "make that a rule" is looked for here, never taken from what the helper says. */
  latestPerson: string;
  botMd: string;
  /** lessons.md as it is now, null when the bot has none yet. */
  lessons: string | null;
  /** The scenario set file the cases go into, as it is now (null when it does not exist). Its name is `evalSetNameOf` of BOT.md. */
  evalSet: string | null;
  corrections: readonly CorrectionArg[];
}

export interface PlannedFile {
  path: string;
  /** The text the proposal is made against (null: a new file). */
  base: string | null;
  content: string;
  role: WorkshopProposalRole;
  title: string;
  note: string;
}

export type RuleOutcome = 'filed' | 'already_a_rule' | 'none' | 'refused';

export interface CorrectionResult {
  lesson: string;
  status: 'recorded' | 'refused' | 'needs_fix';
  /** Why it was refused or needs a fix, in a plain sentence the helper can act on. */
  reason?: string;
  /** How many times this lesson has now been told (1 = the first time). */
  told: number;
  rule: RuleOutcome;
  ruleReason?: 'asked' | 'repeated';
  evalCase: 'added' | 'already_there' | 'none';
}

export interface Plan {
  files: PlannedFile[];
  results: CorrectionResult[];
  /** Things the person should know that are not a refusal (the notes are over their limit and cannot be shortened by the platform, the scenario set could not be named in BOT.md). */
  warnings: string[];
  compacted: { merged: number; dropped: number; droppedTexts: string[] } | null;
}

/** The scenario set the cases go into: the one BOT.md names, else `lessons`. */
export const evalSetNameOf = (fm: BotFrontmatter): string => fm.evals?.set ?? LESSON_EVAL_SET;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The lessons that were dropped, named for the reviewer (the first few; the diff shows all of them). */
export const droppedNote = (texts: readonly string[]): string => {
  if (texts.length === 0) return '';
  const shown = texts.slice(0, 5).map((t) => `“${clip(t, 100)}”`).join('; ');
  return `Dropped: ${shown}${texts.length > 5 ? ` and ${String(texts.length - 5)} more` : ''}. `;
};

export function planCorrections(input: PlanInput): { ok: true; plan: Plan } | { ok: false; message: string } {
  const bot = parseBotMd(input.botMd);
  if (!bot.ok) return { ok: false, message: `BOT.md does not load right now (${bot.failure.message.slice(0, 300)}), so nothing can be added to it. A person has to fix that file first.` };
  const fm = bot.frontmatter;
  const gates: GateContext = { needsApproval: fm.approvals?.needsApproval ?? [] };
  const set = evalSetNameOf(fm);

  let lessons = input.lessons;
  let botMd = input.botMd;
  let evalText = input.evalSet;
  let casesAdded = 0;
  let lessonsAdded = 0;
  let rulesAdded = 0;
  const results: CorrectionResult[] = [];
  const warnings: string[] = [];
  const sole = input.corrections.length === 1;
  const asked = asksForRule(input.latestPerson);

  for (const c of input.corrections) {
    const lesson = c.lesson.replace(/\s+/g, ' ').trim();
    const base: CorrectionResult = { lesson: clip(lesson, 120), status: 'refused', told: 1, rule: 'none', evalCase: 'none' };
    if (lesson.length < 8 || lesson.length > LESSON_MAX_CHARS) {
      results.push({ ...base, status: 'needs_fix', reason: `A lesson is one sentence of 8 to ${String(LESSON_MAX_CHARS)} characters.` });
      continue;
    }
    const blocked = contradiction(lesson, gates);
    if (blocked !== null) {
      results.push({ ...base, reason: blocked });
      continue;
    }
    const ruleText = (c.rule ?? lesson).replace(/\s+/g, ' ').trim();
    const ruleBlocked = c.rule === undefined ? null : contradiction(ruleText, gates);
    if (ruleBlocked !== null) {
      results.push({ ...base, reason: ruleBlocked });
      continue;
    }
    // the test for the lesson: built and checked first, so a lesson whose test is not valid is sent back whole (nothing half-recorded)
    const made = evalCaseFor({
      lesson,
      date: input.today,
      question: c.question,
      mustMention: c.mustMention,
      mustNotMention: c.mustNotMention,
      mustCall: c.mustCall,
      mustNotCall: c.mustNotCall,
    });
    if (!made.ok) {
      results.push({ ...base, status: 'needs_fix', reason: `The test for this lesson is not valid: ${made.message}. Give a question and at least one thing the answer must say, must not say, must call or must not call.` });
      continue;
    }
    const added: ReturnType<typeof withEvalCase> = hasCaseForLesson(evalText, lesson) && evalText !== null ? { ok: true, content: evalText, added: false } : withEvalCase(evalText, set, made.case);
    if (!added.ok) {
      results.push({ ...base, status: 'needs_fix', reason: added.message });
      continue;
    }

    // how often it was told: the earlier lessons that say the same thing (the word-overlap rule in learning.ts), plus this one
    const earlier = earlierSameLessons(lessons, lesson);
    const told = earlier.reduce((n, l) => n + l.times, 0) + 1;
    const ruleReason: 'asked' | 'repeated' | null = (asked && (sole || c.rule !== undefined)) ? 'asked' : earlier.length > 0 ? 'repeated' : null;
    let rule: RuleOutcome = 'none';
    if (ruleReason !== null) {
      const next = withRule(botMd, ruleText);
      if (next === null) rule = 'already_a_rule';
      else {
        botMd = next;
        rulesAdded += 1;
        rule = 'filed';
      }
    }
    lessons = withLesson(lessons, lessonLine(input.today, lesson), input.slug);
    lessonsAdded += 1;
    evalText = added.content;
    if (added.added) casesAdded += 1;
    results.push({
      lesson: base.lesson,
      status: 'recorded',
      told,
      rule,
      ...(ruleReason !== null ? { ruleReason } : {}),
      evalCase: added.added ? 'added' : 'already_there',
    });
  }

  const files: PlannedFile[] = [];
  const recorded = results.filter((r) => r.status === 'recorded');
  if (recorded.length === 0) return { ok: true, plan: { files, results, warnings, compacted: null } };

  // BOT.md: the rules, and the line that names the scenario set when it has none yet (one proposal for the one file)
  let evalsBlock = false;
  if (casesAdded > 0 && fm.evals === undefined) {
    const next = withEvalsBlock(botMd, set);
    if (next === null) warnings.push('BOT.md could not be given the line that names the scenario set, so the new test cases will not run until a person adds it (evals: set and minScore).');
    else {
      botMd = next;
      evalsBlock = true;
    }
  }
  const ruleLines = rulesOf(botMd).length;
  if (botMd !== input.botMd) {
    const what = [rulesAdded > 0 ? `${String(rulesAdded)} rule${rulesAdded === 1 ? '' : 's'}` : '', evalsBlock ? `the line that names the scenario set “${set}”` : ''].filter((t) => t !== '').join(' and ');
    files.push({
      path: `bots/${input.slug}/BOT.md`,
      base: input.botMd,
      content: botMd,
      role: rulesAdded > 0 ? 'rule' : 'evals_block',
      title: clip(rulesAdded > 0 ? `Add ${what} to ${input.botName}` : `Name the scenario set for ${input.botName}`, 120),
      note: `Comes from a correction made in the Workshop. ${rulesAdded > 0 ? `The rule goes under “Rules from the Workshop” (${String(ruleLines)} there now). ` : ''}Nothing is applied until you approve.`,
    });
  }

  if (lessons !== null && lessons !== input.lessons) {
    const max = maxLinesOf(fm);
    let content = lessons;
    let compacted: { merged: number; dropped: number; droppedTexts: string[] } | null = null;
    if (lineCount(content) > max) {
      const short = compactLessons(content, max);
      if (!short.ok) {
        warnings.push(
          short.reason === 'header'
            ? `The lessons file is over its limit of ${String(max)} lines and its header alone is too long to shorten automatically. A person has to shorten it by hand.`
            : `The lessons file is over its limit of ${String(max)} lines, but it was not shortened: ${short.detail} A person has to shorten it by hand.`,
        );
      } else {
        content = short.content;
        compacted = { merged: short.merged, dropped: short.dropped, droppedTexts: short.droppedTexts };
      }
    }
    files.push({
      path: lessonsPath(input.slug),
      base: input.lessons,
      content,
      role: compacted !== null ? 'compaction' : 'lessons',
      title: clip(
        compacted !== null
          ? `Add ${String(lessonsAdded)} lesson${lessonsAdded === 1 ? '' : 's'} to ${input.botName} and shorten its notes`
          : `Add ${String(lessonsAdded)} lesson${lessonsAdded === 1 ? '' : 's'} for ${input.botName}`,
        120,
      ),
      note:
        compacted !== null
          ? `The lessons file went past its limit of ${String(max)} lines, so lessons that say the same thing are joined (${String(compacted.merged)}) and the oldest are dropped (${String(compacted.dropped)}) to leave room. ${droppedNote(compacted.droppedTexts)}Nothing is applied until you approve.`
          : 'Comes from a correction made in the Workshop. Nothing is applied until you approve.',
    });
    return finish(files, results, warnings, compacted, evalText, input, set, casesAdded);
  }
  return finish(files, results, warnings, null, evalText, input, set, casesAdded);
}

function finish(
  files: PlannedFile[],
  results: CorrectionResult[],
  warnings: string[],
  compacted: { merged: number; dropped: number; droppedTexts: string[] } | null,
  evalText: string | null,
  input: PlanInput,
  set: string,
  casesAdded: number,
): { ok: true; plan: Plan } {
  if (casesAdded > 0 && evalText !== null && evalText !== input.evalSet) {
    files.push({
      path: botEvalSetPath(input.slug, set),
      base: input.evalSet,
      content: evalText,
      role: 'eval',
      title: clip(`Add ${String(casesAdded)} test case${casesAdded === 1 ? '' : 's'} for ${input.botName}`, 120),
      note: 'A test the bot must keep passing, written from a correction made in the Workshop. It runs when this and the lesson are approved. Nothing is applied until you approve.',
    });
  }
  return { ok: true, plan: { files, results, warnings, compacted } };
}
