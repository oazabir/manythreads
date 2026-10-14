import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// A bot's scenario set (SPEC §7.2 "Evals": a scenario set, a minimum score; PLAN P5-19, P7-08). BOT.md names the set in `evals: { set, minScore }`;
// the set itself is a file of the bot's folder, `bots/<slug>/evals/<set>.yaml`, written as data and read by the harness (P7-08) and by the
// template test. A case says what the world holds (`given`), what is asked (`question`) and what the answer must and must not do (`expect`):
// every assertion is something a program can check against the Answer the bot posted (its citations, its outside-scope list, its text) and the
// calls its run made, so a score is a count, not an opinion. What a harness does with a case is its own matter; this file only fixes the shape.

/** Largest scenario set file read (UTF-16 code units, checked before anything is parsed): a set is a list of short cases. */
export const BOT_EVAL_SET_MAX_CHARS = 64 * 1024;
export const BOT_EVAL_SET_MAX_CASES = 100;
export const BOT_EVAL_FOLDER = 'evals';

const SetSlug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, ".", "_" or "-"').max(64);
const CaseId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits or "-"').max(64);
/** `namespace.verb`, optionally `namespace.*` (the same words as BOT.md's capability list). */
const Capability = z.string().regex(/^[a-z][a-z0-9_]*(\.([a-z][a-z0-9_]*|\*))+$/, 'namespace.verb or namespace.*');
/** An open set of words like the Answer's: `message`, `page`, `file`, `memory`, `mail`, `drive`, ... */
const KindWord = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'a lowercase word');
/** A token or a phrase looked for in the answer's text, a citation's label or its snippet (case-insensitive). */
const Phrase = z.string().min(1).max(120);

/** One thing the scenario's world holds: what it is, whose it is, and whether the person asking may open it. */
export const BotEvalSource = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(32),
  kind: KindWord,
  /** `team` anybody on the team may open it; `channel` only the people of a private place; `person` one person's own (their connection, their conversation). */
  scope: z.enum(['team', 'channel', 'person']),
  /** False for a source that exists but that the person asking may not open (somebody else's Drive, a private channel they are not in). */
  visibleToAsker: z.boolean(),
  text: z.string().min(1).max(600),
});
export type BotEvalSource = z.infer<typeof BotEvalSource>;

export const BotEvalGiven = z.strictObject({
  /**
   * Where the question is asked: `conversation` (the person's private conversation with the bot: its only reader is the asker), `thread` (inside a
   * thread of a channel: the thread is part of the scenario and its readers are the channel's), `channel` (a mention at the top of a channel).
   * Left out: `conversation`.
   */
  where: z.enum(['conversation', 'thread', 'channel']).optional(),
  /** The asking person's own switch for mail (SPEC §20: opt-in per person). Left out: `off`. */
  mail: z.enum(['off', 'on']).optional(),
  sources: z.array(BotEvalSource).max(12).optional(),
});
export type BotEvalGiven = z.infer<typeof BotEvalGiven>;

/**
 * What a case asserts. Every key is optional but one must be there; a case that asserts nothing could never fail.
 * All assertions are checked against the Answer the run posted (`answer.post`) and the calls the run made.
 */
export const BotEvalExpect = z
  .strictObject({
    /** At least this many citations survive in the Answer. */
    minCitations: z.number().int().min(0).max(40).optional(),
    /** At most this many (0 = the answer cites nothing). */
    maxCitations: z.number().int().min(0).max(40).optional(),
    /** Every one of these kinds appears among the Answer's citations. */
    citesKinds: z.array(KindWord).min(1).max(8).optional(),
    /** Each phrase appears in the answer's text. */
    mentions: z.array(Phrase).min(1).max(10).optional(),
    /** None of these appears anywhere in the Answer: its text, a label, a snippet, a chip, the outside-scope list. */
    notMentions: z.array(Phrase).min(1).max(10).optional(),
    /** The Answer carries an outside-scope list (and says in words what it could not reach), or, when false, none. */
    statesOutsideScope: z.boolean().optional(),
    /** These kinds are named in the outside-scope list. */
    outsideScopeKinds: z.array(KindWord).min(1).max(8).optional(),
    /** The answer says, in one plain sentence, that what it reached does not answer the question, and invents no source. */
    statesUnknown: z.boolean().optional(),
    /** The Answer offers a hand-off chip to a bot that does the thing asked for. */
    offersHandoff: z.boolean().optional(),
    /** Calls the run must make (`required`) and must never make (`forbidden`). `x.*` names a namespace. */
    toolCalls: z
      .strictObject({
        required: z.array(Capability).min(1).max(12).optional(),
        forbidden: z.array(Capability).min(1).max(12).optional(),
      })
      .refine((c) => c.required !== undefined || c.forbidden !== undefined, { message: 'name required or forbidden calls' })
      .optional(),
  })
  .refine((e) => Object.values(e).some((v) => v !== undefined), { message: 'a case must assert something' })
  .refine((e) => e.minCitations === undefined || e.maxCitations === undefined || e.minCitations <= e.maxCitations, {
    message: 'minCitations is above maxCitations',
    path: ['minCitations'],
  });
export type BotEvalExpect = z.infer<typeof BotEvalExpect>;

export const BotEvalCase = z.strictObject({
  id: CaseId,
  question: z.string().min(1).max(500),
  given: BotEvalGiven.optional(),
  expect: BotEvalExpect,
  /** Why this case is in the set: one or two sentences for the person who reads a failure. */
  rationale: z.string().min(1).max(300),
});
export type BotEvalCase = z.infer<typeof BotEvalCase>;

export const BotEvalSet = z
  .strictObject({
    /** Implied 1; a later version writes the key explicitly (PLAN.md B.4 rule 5). */
    schema: z.literal(1).default(1),
    /** The set's name: the file's stem, and what BOT.md's `evals.set` says. */
    set: SetSlug,
    cases: z.array(BotEvalCase).min(1).max(BOT_EVAL_SET_MAX_CASES),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.cases.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: 'custom', path: ['cases', i, 'id'], message: `duplicate case id "${c.id}"` });
      seen.add(c.id);
    });
  });
export type BotEvalSet = z.infer<typeof BotEvalSet>;

/** `bots/<slug>/evals/<set>.yaml`: where a bot's scenario set lives in the team repo. */
export const botEvalSetPath = (botSlug: string, set: string): string => `bots/${botSlug}/${BOT_EVAL_FOLDER}/${set}.yaml`;

export type BotEvalSetParse = { ok: true; set: BotEvalSet } | { ok: false; message: string };

/** Parse one scenario set file strictly. The message is one line for the first problems, in the words the loader's own banner uses. */
export function parseBotEvalSet(content: string): BotEvalSetParse {
  if (content.length > BOT_EVAL_SET_MAX_CHARS) return { ok: false, message: `the scenario set is larger than ${BOT_EVAL_SET_MAX_CHARS / 1024} KB` };
  let doc: unknown;
  try {
    doc = parseYaml(content.replace(/^﻿/, ''), { maxAliasCount: 20 });
  } catch (err) {
    return { ok: false, message: `scenario set: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = BotEvalSet.safeParse(doc);
  if (parsed.success) return { ok: true, set: parsed.data };
  const lines = parsed.error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.map(String).join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
  const rest = parsed.error.issues.length - lines.length;
  return { ok: false, message: `${lines.join('; ')}${rest > 0 ? ` (+${rest} more)` : ''}`.slice(0, 1000) };
}
