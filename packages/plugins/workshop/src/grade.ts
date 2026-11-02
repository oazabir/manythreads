import {
  SETUP_MAX_QUESTIONS,
  isGap,
  type Grade,
  type GradedRequirement,
  type SetupInventory,
  type SetupQuestion,
  type SetupRequirement,
} from '@manythreads/shared';

// Grading (PLAN P7-03): how each thing a brief needs stands against what the team has. The setup helper (a model) lists the requirements; this file, plain code, gives each its grade
// and the reason, so a model that is wrong, or was led astray by the brief, cannot call a missing tool "covered". Nothing here reads a database: it is a function of the requirement
// and the inventory `describe_self` produced.

export interface Graded {
  grade: Grade;
  reason: string;
}

const named = (req: SetupRequirement): string => req.name ?? req.text;

/** The ways a bot can be started that exist in this release, and the two that need a connection to another app (none exist yet). */
const needsConnection = (type: string): boolean => type === 'inbox' || type === 'webhook';

export function gradeRequirement(req: SetupRequirement, inv: SetupInventory): Graded {
  const name = req.name?.trim() ?? '';
  const canGrantDangerous = inv.asker.canGrantDestructive;
  switch (req.kind) {
    case 'capability': {
      if (name === '') return { grade: 'unclear', reason: 'The brief does not say which tool the bot needs.' };
      const tool = inv.capabilities.find((c) => c.name === name);
      if (!tool) return { grade: 'unclear', reason: `There is no tool called "${name}" on this platform.` };
      if (!tool.destructive) return { grade: 'covered', reason: `"${name}" is a tool the bot can simply be given.` };
      return canGrantDangerous
        ? { grade: 'grantable', reason: `"${name}" can change things, so it is given with "ask a person first" on, and you may grant it.` }
        : { grade: 'blocked', reason: `"${name}" can change things, so only a team lead or an admin may give it to a bot.` };
    }
    case 'runtime': {
      if (name === '') return { grade: 'unclear', reason: 'The brief does not say whether the bot needs a shell, files or a browser.' };
      if (!inv.runtimeAllowed.includes(name)) return { grade: 'blocked', reason: `This team has not allowed bots to use ${name}.` };
      return canGrantDangerous
        ? { grade: 'grantable', reason: `This team allows ${name} for bots, and you may grant it.` }
        : { grade: 'blocked', reason: `This team allows ${name} for bots, but only a team lead or an admin may grant it.` };
    }
    case 'knowledge': {
      if (name === '') return { grade: 'unclear', reason: 'The brief does not say which knowledge base the bot should read.' };
      return inv.knowledge.some((k) => k.slug === name)
        ? { grade: 'covered', reason: `The team has a knowledge base called "${name}".` }
        : { grade: 'missing', reason: `The team has no knowledge base called "${name}" yet.` };
    }
    case 'skill': {
      if (name === '') return { grade: 'unclear', reason: 'The brief does not say which skill the bot needs.' };
      return inv.skills.some((s) => s.slug === name)
        ? { grade: 'covered', reason: `The team has a skill called "${name}".` }
        : { grade: 'missing', reason: `The team has no skill called "${name}" yet.` };
    }
    case 'connection':
      return inv.connections.length > 0 && name !== '' && inv.connections.some((c) => c.name === name)
        ? { grade: 'covered', reason: `The team has a connection called "${name}".` }
        : { grade: 'missing', reason: 'Connections to other apps are not available yet, so the bot cannot reach it.' };
    case 'runner': {
      if (name === '') return { grade: 'covered', reason: "The bot will run on the team's default runner." };
      // the same words whether the runner does not exist or the team may not use it: the team learns nothing about runners it cannot use
      return inv.runners.some((r) => r.name === name)
        ? { grade: 'covered', reason: `The team may use the runner "${name}".` }
        : { grade: 'blocked', reason: `"${name}" is not a runner this team may use.` };
    }
    case 'trigger': {
      if (name === '') return { grade: 'unclear', reason: 'The brief does not say what should start the bot.' };
      const trigger = inv.triggers.find((t) => t.type === name);
      if (!trigger) return { grade: 'unclear', reason: `"${name}" is not a way a bot can be started.` };
      if (needsConnection(name) || !trigger.available) return { grade: 'missing', reason: trigger.note ?? `"${name}" needs a connection to another app, which is not available yet.` };
      return { grade: 'covered', reason: `A bot can be started by "${name}".` };
    }
    case 'model': {
      if (name === '') return { grade: 'covered', reason: "The bot will use the team's usual models." };
      return inv.models.some((m) => m.alias === name)
        ? { grade: 'covered', reason: `The model "${name}" is set up.` }
        : { grade: 'missing', reason: `The model "${name}" is not set up in this workspace.` };
    }
    case 'other':
      return { grade: 'unclear', reason: `"${named(req)}" is something the helper cannot check; it needs your word on it.` };
  }
}

/** How strict a grade is; a re-grading never goes down this ladder for the same requirement. */
const STRICTNESS: Record<Grade, number> = { covered: 0, grantable: 1, unclear: 2, missing: 3, blocked: 4 };

/** Grades a list. Order is kept and nothing is dropped: two entries with one id are both graded, and `mergeGraded` decides what stands. */
export function gradeAll(requirements: readonly SetupRequirement[], inv: SetupInventory): GradedRequirement[] {
  return requirements.map((req) => ({ ...req, ...gradeRequirement(req, inv) }));
}

const sameThing = (a: SetupRequirement, b: SetupRequirement): boolean => a.kind === b.kind && (a.name ?? '') === (b.name ?? '');

/** An id not in `taken`, built from `id`: `mail`, then `mail-2`, `mail-3` (the id stays within the 40 characters a requirement id may have). */
function freshId(id: string, taken: ReadonlySet<string>): string {
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${id.slice(0, 40 - String(n).length - 1)}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${id.slice(0, 30)}-${String(taken.size + 1)}`;
}

/**
 * Merge the requirements of a new listing into those already graded (earlier rounds, or earlier in the same listing). The platform's earlier verdict is never loosened by a later listing:
 *  - the same id for the same thing (kind and name) keeps the stricter of the two grades, so a gap is never turned into "covered" by listing it again;
 *  - the same id for a DIFFERENT thing does not take the old one's place: the old entry (and its gap) stays and the new one is added under a fresh id.
 * New ids are added. Pure; the inputs are not changed.
 */
export function mergeGraded(before: readonly GradedRequirement[], now: readonly GradedRequirement[]): GradedRequirement[] {
  const out = [...before];
  for (const r of now) {
    const at = out.findIndex((x) => x.id === r.id && sameThing(x, r));
    if (at >= 0) {
      const old = out[at] as GradedRequirement;
      if (STRICTNESS[r.grade] > STRICTNESS[old.grade]) out[at] = { ...old, grade: r.grade, reason: r.reason };
      continue;
    }
    const taken = new Set(out.map((x) => x.id));
    out.push(taken.has(r.id) ? { ...r, id: freshId(r.id, taken) } : r);
  }
  return out;
}

export const gapsOf = (graded: readonly GradedRequirement[]): GradedRequirement[] => graded.filter((r) => isGap(r.grade));

const DEFAULT_OPTIONS: Record<'missing' | 'blocked' | 'unclear', (req: GradedRequirement) => { question: string; options: string[] }> = {
  missing: (req) => ({
    question: `${req.text}: ${req.reason} What should we do?`,
    options: req.kind === 'skill' ? ['Create a starter skill', 'Leave it out'] : ['Leave it out', 'I will add it first'],
  }),
  blocked: (req) => ({ question: `${req.text}: ${req.reason} What should we do?`, options: ['Leave it out', 'I will ask a team lead'] }),
  unclear: (req) => ({ question: `${req.text}: ${req.reason}`, options: [] }),
};

/**
 * One question for each gap, batched into one list. The helper may word a question itself (`asked`, by requirement id); when it does not, or the words are unusable, the platform's own
 * question for that kind of gap is used. The ids continue from `taken`, the number of questions asked in earlier rounds, so an answer always names exactly one question.
 */
export function questionsForGaps(graded: readonly GradedRequirement[], asked: ReadonlyMap<string, { question?: string; options?: string[] }>, taken: number): SetupQuestion[] {
  const gaps = gapsOf(graded).slice(0, SETUP_MAX_QUESTIONS);
  return gaps.map((req, i) => {
    const fallback = DEFAULT_OPTIONS[req.grade as 'missing' | 'blocked' | 'unclear'](req);
    const mine = asked.get(req.id);
    const question = mine?.question?.trim();
    const options = (mine?.options ?? []).map((o) => o.trim()).filter((o) => o !== '' && o.length <= 80).slice(0, 4);
    return {
      id: `q${String(Math.min(taken + i + 1, 999))}`,
      requirementId: req.id,
      question: (question !== undefined && question !== '' ? question : fallback.question).slice(0, 400),
      options: options.length > 0 ? options : fallback.options,
    };
  });
}

/** The sentences for "what the bot will not be able to do", one for each requirement the team could not meet. */
export function limitsOf(graded: readonly GradedRequirement[]): string[] {
  return gapsOf(graded)
    .map((r) => {
      const lead = r.grade === 'missing' ? 'Not available yet' : r.grade === 'blocked' ? 'Not allowed' : 'Not settled';
      return `${lead}: ${r.text} (${r.reason})`.slice(0, 400);
    })
    .slice(0, 20);
}
