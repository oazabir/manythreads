import { createHash } from 'node:crypto';
import {
  BOT_EVAL_SET_MAX_CASES,
  BOT_EVAL_SET_MAX_CHARS,
  BotEvalCase,
  botEvalSetPath,
  parseBotEvalSet,
  parseBotMd,
  type BotFrontmatter,
} from '@manythreads/shared';
import { Document, parseDocument } from 'yaml';

// The learning loop of the Workshop (PLAN P7-06, SPEC section 9): what a correction from a person becomes. Everything here is plain code over text, so the model chooses only WHAT to record
// (the wording, the question for the test) and the platform decides what is allowed, what counts as a repeat, when a file has grown too long and what the new text of each file is.
// Nothing here writes a file. The results are texts that become proposals, which a person approves (docs/plugins/workshop.md).

/** `bots/<slug>/lessons.md`: the corrections the team collected for the bot. The same file the memory plugin's `appendLesson` writes (as the platform, not as a proposal). */
export const lessonsPath = (slug: string): string => `bots/${slug}/lessons.md`;

/** A lesson is one short line. */
export const LESSON_MAX_CHARS = 400;
/** The scenario set a bot's corrections go into when BOT.md does not name one yet. */
export const LESSON_EVAL_SET = 'lessons';
/** What BOT.md names a new scenario set with: the share of its cases that must pass. */
export const LESSON_EVAL_MIN_SCORE = 0.8;
/** The heading of the rules a person asked for (or a repeated lesson became), at the end of BOT.md's instructions. */
export const RULES_HEADING = '## Rules from the Workshop';
/** The limit on the lines of lessons.md when BOT.md names none. It is the same key as the memory file's (`memory.maxLines`): one number for a bot's notes. */
export const LESSONS_DEFAULT_MAX_LINES = 200;

// ---- what counts as the same lesson ---------------------------------------------------------------------------------------------------------------------------------------

/** Two lessons are the same lesson when this share of all the words either uses is words both use (Jaccard similarity of the word sets, see `similarity`). */
export const REPEAT_SIMILARITY = 0.6;
/** A lesson of fewer meaningful words than this is compared only for equality: two or three words say too little to call a different sentence "the same". */
export const MIN_WORDS_TO_COMPARE = 3;

const STOP = new Set(
  'a an the and or but if so to of in on at for from with by as is are was were be been it its this that these those you your we our they their he she i me my do does did not no yes can could should would will just also than then there here when while what which who how why all any some more most very too into out up down over under about again always never'.split(
    ' ',
  ),
);

/**
 * The marker of a negation in a word set. "Use metric units" and "Never use metric units" share every word but say the opposite, so a text that holds any negating word ("not", "never", "don't",
 * "without", "avoid", "stop" ...) carries this marker, and two sets with different markers are never the same lesson (`similarity`).
 */
export const NEGATION = '!';
const NEGATORS = new Set('not no never dont doesnt didnt cant cannot wont shouldnt isnt arent wasnt without avoid stop nobody nothing neither nor'.split(' '));

/** Invisible characters that can split a word without showing (zero-width spaces and joiners, the soft hyphen, the byte order mark). */
const INVISIBLE = /[\u200B-\u200F\u2060-\u2064\u00AD\uFEFF]/g;

/** The words of a text, lower case, unicode letters and numbers, apostrophes closed up ("don't" is `dont`), `w/o` read as `without`, a few two-word phrases joined so they count as one negator. */
function tokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .toLowerCase()
    .replace(/\bw\/o\b/g, ' without ')
    .replace(/\binstead of\b/g, ' insteadof ')
    .replace(/\bno longer\b/g, ' nolonger ')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '');
}

/**
 * Lower case words, no stop words, a crude and deterministic stem (plural and past tense ends cut), as a set; plus the negation marker when the text negates something. Words in any script
 * count (a text in another language is compared by its own words). The same text always gives the same set.
 */
export function lessonWords(text: string): string[] {
  const out = new Set<string>();
  for (const raw of tokens(text)) {
    if (NEGATORS.has(raw) || raw === 'insteadof' || raw === 'nolonger') {
      out.add(NEGATION);
      continue;
    }
    if ([...raw].length < 2 || STOP.has(raw)) continue;
    let w = raw;
    if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 3 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
    if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
    if ([...w].length >= 2) out.add(w);
  }
  return [...out].sort();
}

/**
 * 0 to 1: how much of the two word sets is shared. Two sets with fewer than `MIN_WORDS_TO_COMPARE` words are 1 only when they are equal and 0 otherwise. A set that negates something and one that
 * does not (see `NEGATION`) are never the same: 0.
 */
export function similarity(a: readonly string[], b: readonly string[]): number {
  if (a.includes(NEGATION) !== b.includes(NEGATION)) return 0;
  const x = a.filter((w) => w !== NEGATION);
  const y = b.filter((w) => w !== NEGATION);
  if (x.length < MIN_WORDS_TO_COMPARE || y.length < MIN_WORDS_TO_COMPARE) return x.length > 0 && x.length === y.length && x.every((w, i) => w === y[i]) ? 1 : 0;
  const ys = new Set(y);
  let shared = 0;
  for (const w of x) if (ys.has(w)) shared += 1;
  return shared / (x.length + y.length - shared);
}

export interface LessonLine {
  /** Position among the lines of the file (0 based). */
  line: number;
  date: string | null;
  text: string;
  /** How many times the line says it was told (`(told 3 times)`), 1 when it says nothing. */
  times: number;
}

const TOLD = / \(told (\d{1,3}) times\)$/;

/** The lesson lines of a lessons.md: every line that starts with `- `. A header, a blank line or a paragraph is not a lesson. */
export function lessonLines(content: string): LessonLine[] {
  const out: LessonLine[] = [];
  content.split(/\r?\n/).forEach((raw, line) => {
    if (!raw.startsWith('- ')) return;
    const body = raw.slice(2).trim();
    const dated = /^(\d{4}-\d{2}-\d{2}):\s*(.*)$/.exec(body);
    const text0 = dated ? (dated[2] as string) : body;
    const told = TOLD.exec(text0);
    out.push({ line, date: dated ? (dated[1] as string) : null, text: told ? text0.slice(0, told.index) : text0, times: told ? Math.max(2, Number(told[1])) : 1 });
  });
  return out;
}

/** The earlier lessons that say what `text` says. The new lesson makes a rule when at least one does (it has now been told a second time). */
export function earlierSameLessons(content: string | null, text: string): LessonLine[] {
  const words = lessonWords(text);
  return lessonLines(content ?? '').filter((l) => similarity(words, lessonWords(l.text)) >= REPEAT_SIMILARITY);
}

/** One line of lessons.md, the form `appendLesson` of the memory plugin writes. */
export const lessonLine = (date: string, text: string): string => `- ${date}: ${text.replace(/\s+/g, ' ').trim()}`;

/** The file with the line added at the end (and a header when the file is new). */
export function withLesson(content: string | null, line: string, slug: string): string {
  if (content === null || content.trim() === '') return `# Lessons for ${slug}\n\nCorrections from the team, collected by the Workshop.\n\n${line}\n`;
  return `${content.replace(/\s+$/, '')}\n${line}\n`;
}

/**
 * A lesson told again in other words is not written a second time. The line that already says it is kept, with the oldest date, and gets the count `(told N times)` instead; the count is what
 * turns a repeat into a rule. The rest of the file is left exactly as it was.
 */
export function withRepeat(content: string, at: LessonLine): string {
  const lines = content.split('\n');
  const raw = lines[at.line];
  if (raw === undefined || !raw.startsWith('- ')) return content;
  const tail = raw.endsWith('\r') ? '\r' : '';
  lines[at.line] = `- ${at.date ? `${at.date}: ` : ''}${at.text} (told ${String(Math.min(at.times + 1, 999))} times)${tail}`;
  return lines.join('\n');
}

/** How many lines the file has (a final empty line is not one). */
export const lineCount = (content: string): number => (content === '' ? 0 : content.replace(/\n$/, '').split('\n').length);

/** The limit on lines: BOT.md's `memory.maxLines`, else `LESSONS_DEFAULT_MAX_LINES`. */
export const maxLinesOf = (fm: BotFrontmatter): number => fm.memory?.maxLines ?? LESSONS_DEFAULT_MAX_LINES;

export type Compaction =
  | { ok: true; content: string; merged: number; dropped: number; /** The lessons that went, as `date: text`, so the proposal can name them. */ droppedTexts: string[] }
  /** `header`: the lines above the first lesson alone fill the target. `unreadable`: the file has content the platform cannot place (a paragraph, an indented line, a `*` bullet after the first lesson). */
  | { ok: false; reason: 'header' | 'unreadable'; detail: string };

/**
 * A shorter lessons.md. Deterministic, in two steps, newest wins: (1) lessons that say the same thing (`similarity` at the repeat threshold, opposite meanings never) become one line, the newest
 * wording, marked `(told N times)`; (2) if the file is still above three quarters of the limit, the oldest lessons go until it is not. The header (everything above the first lesson) is kept as
 * it is. The platform only rewrites what it can read: from the first lesson on, every line must be a `- ` lesson or blank. A file with anything else there (a hand-written section, a line that
 * continues a lesson, a `*` bullet) is not compacted, because the rewrite would delete it without a word; a person shortens that file by hand.
 */
export function compactLessons(content: string, maxLines: number): Compaction {
  const target = Math.max(5, Math.floor(maxLines * 0.75));
  const lines = content.replace(/\r?\n$/, '').split(/\r?\n/);
  const first = lines.findIndex((l) => l.startsWith('- '));
  const header = first === -1 ? lines : lines.slice(0, first);
  if (header.length >= target) return { ok: false, reason: 'header', detail: 'The lines above the first lesson alone fill the space the shortened file may use.' };
  const oddAt = first === -1 ? -1 : lines.findIndex((l, i) => i > first && l.trim() !== '' && !l.startsWith('- '));
  if (oddAt !== -1) return { ok: false, reason: 'unreadable', detail: `Line ${String(oddAt + 1)} (“${clipText(lines[oddAt] as string, 60)}”) is not a lesson line, and shortening would delete it.` };
  const items = lessonLines(content);
  type Item = { date: string | null; text: string; times: number; words: string[] };
  const kept: Item[] = [];
  let merged = 0;
  // newest first, so the newest wording represents its group
  for (const l of [...items].reverse()) {
    const words = lessonWords(l.text);
    const same = kept.find((k) => similarity(k.words, words) >= REPEAT_SIMILARITY);
    if (same) {
      same.times += l.times;
      merged += 1;
    } else {
      kept.push({ date: l.date, text: l.text, times: l.times, words });
    }
  }
  const droppedTexts: string[] = [];
  while (header.length + kept.length > target && kept.length > 1) {
    const gone = kept.pop() as Item;
    droppedTexts.push(`${gone.date ? `${gone.date}: ` : ''}${gone.text}`);
  }
  const body = kept.reverse().map((k) => `- ${k.date ? `${k.date}: ` : ''}${k.text}${k.times > 1 ? ` (told ${String(Math.min(k.times, 999))} times)` : ''}`);
  return { ok: true, content: `${[...header, ...body].join('\n')}\n`, merged, dropped: droppedTexts.length, droppedTexts };
}

const clipText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---- what a lesson may not say --------------------------------------------------------------------------------------------------------------------------------------------

export interface GateContext {
  /** The tools BOT.md lists under `approvals.needsApproval`: a lesson must not tell the bot to use one without asking. */
  needsApproval: readonly string[];
}

/** Words that set a check aside. */
const DISMISS = new Set(
  'skip skipping bypass bypassing ignore ignoring disable disabling circumvent circumventing override overriding waive waiving remove removing disregard disregarding drop dropping suspend suspending'.split(' '),
);
/** The checks a person or the platform set up. */
const PROTECTED = new Set(
  'approval approvals approve approver approvers guard guards guardrail guardrails gate gates filter filters dlp limit limits budget budgets review reviews reviewer permission permissions confirmation confirmations policy policies redaction rule rules instruction instructions check checks safeguard safeguards'.split(
    ' ',
  ),
);
/** Words that turn a refusal into its opposite: "don't forget the review", "never skip the approval" keep a check. */
const KEEPS = new Set('forget skip skipping miss omit neglect leave bypass bypassing ignore ignoring disable disabling override overriding remove removing disregard disregarding drop dropping'.split(' '));
/** A word that says "do not" (or "instead of", "without") in front of what follows. */
const NEGATE = new Set('never dont doesnt not no cant cannot shouldnt wont avoid stop without insteadof nolonger'.split(' '));
const CHECKS = new Set(
  'asking ask approval approvals permission review reviewing confirmation confirming confirm checking check guard guardrail guardrails filter limit limits budget gate redaction anyone person lead manager'.split(' '),
);
const APPROVAL_OBJECTS = new Set(['approval', 'approvals', 'permission', 'review', 'confirmation', 'confirm', 'confirming', 'consent']);
const ASK_WHO = new Set(['first', 'lead', 'manager', 'person', 'anyone', 'someone', 'human', 'approver', 'owner']);
/** Asking, or waiting for, a person's say. */
const ASK_WAIT = new Set('ask asking asked wait waiting seek seeking confirm confirming'.split(' '));
/** What is asked for or waited for. */
const SAY_OBJECTS = new Set([...APPROVAL_OBJECTS, 'lead', 'manager', 'approver', 'owner', 'human', 'someone', 'anyone', 'person', 'first', 'okay', 'ok']);
const OPTIONAL = new Set('optional suggestion suggestions advisory merely nonbinding'.split(' '));
/** Words for putting something out into the world: with "go ahead", or "directly", they say "without waiting for a say". */
const ACTION = new Set('post posting send sending publish publishing merge merging deploy deploying delete deleting push pushing commit committing'.split(' '));
const IMMEDIATELY = new Set('directly automatically auto immediately instantly straight'.split(' '));
const REVEAL = new Set('share post paste print show reveal send include output repeat write give tell leak expose answer answering reply replying respond responding provide providing use using quote quoting'.split(' '));
const SECRET = new Set('password passwords secret secrets token tokens credential credentials apikey apikeys passphrase'.split(' '));
/** "key" is a secret only after one of these ("API key"); on its own it is an ordinary word ("key points"). */
const KEY_KINDS = new Set('api secret private access ssh encryption license licence auth signing master'.split(' '));

const within = (words: readonly string[], from: number, span: number, set: ReadonlySet<string>): boolean => {
  for (let i = from + 1; i <= from + span && i < words.length; i += 1) if (set.has(words[i] as string)) return true;
  return false;
};
const before = (words: readonly string[], at: number, span: number, set: ReadonlySet<string>): boolean => {
  for (let i = Math.max(0, at - span); i < at; i += 1) if (set.has(words[i] as string)) return true;
  return false;
};
const negatedBefore = (words: readonly string[], at: number, span: number): boolean => before(words, at, span, NEGATE);

const NOT_ENGLISH = 'The checks can only read English words. Write the lesson in English (a name or a short quote in another language is fine), then it can be recorded.';

/** Whether the text is written mostly with letters the checks cannot read, or mixes scripts inside one word (a look-alike letter in the middle of "ignore"). */
function unreadable(text: string, words: readonly string[]): boolean {
  const letters = text.normalize('NFKC').match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const ascii = letters.filter((c) => /[a-z]/i.test(c)).length;
  if ((letters.length - ascii) / letters.length > 0.2) return true;
  return words.some((w) => /[a-z]/.test(w) && /[^\p{ASCII}]/u.test(w));
}

/**
 * Why a lesson (or a rule) must not be taken, or null. A lesson teaches the bot how to do its work better; it can never loosen what a person or the platform decided: asking before a change,
 * the guard, a limit, a budget, a review, the data-loss filter, keeping a secret out of a message. This is a check on the WORDS, deterministic and linear in the length of the text, and
 * deliberately cautious: when it refuses a lesson that was harmless, the person rewrites it. It reads English only: text mostly in another language is refused with that reason instead of
 * passing unread. A bypass that is itself negated ("never skip the review") is fine. What it does not do is understand a sentence: a lesson that gets round a check in words it has no entry for
 * will pass, which is why every file the helper changes is still a proposal a person approves.
 */
export function contradiction(text: string, gates: GateContext): string | null {
  const words = tokens(text);
  if (unreadable(text, words)) return NOT_ENGLISH;
  const text2 = ` ${words.join(' ')} `;
  const gate = 'A lesson cannot tell the bot to skip a check a person or the platform set up (asking first, a guard, a limit, a review). ';
  // a tool that needs a person's approval, named with "automatically", "directly" ...
  for (const tool of gates.needsApproval) {
    const t = ` ${tokens(tool).join(' ')} `;
    const at = text2.indexOf(t);
    if (at === -1) continue;
    const around = tokens(text2.slice(Math.max(0, at - 60), at + t.length + 60));
    if (around.some((x) => IMMEDIATELY.has(x)) && !around.some((x) => NEGATE.has(x))) return `${gate}“${tool}” needs a person’s approval each time, so a lesson cannot say to use it “automatically”.`;
  }
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] as string;
    // skip / bypass / ignore / disregard ... within five words of an approval, guard, limit, review ...
    if (DISMISS.has(w) && (within(words, i, 5, PROTECTED) || before(words, i, 2, PROTECTED)) && !negatedBefore(words, i, 3)) return `${gate}Leave out the part about “${w}”.`;
    // "turn off" / "switch off" a protected thing
    if ((w === 'turn' || w === 'switch') && words[i + 1] === 'off' && within(words, i + 1, 5, PROTECTED) && !negatedBefore(words, i, 3)) return `${gate}Leave out the part about turning it off.`;
    // "treat the DLP guard as optional", "take the budget limit as a suggestion only", "the review is optional"
    if (OPTIONAL.has(w) && before(words, i, 6, PROTECTED) && (w === 'optional' || w === 'nonbinding' || before(words, i, 4, AS)) && !negatedBefore(words, i, 3)) {
      return `${gate}A check is not “${w}”: it stays as it is.`;
    }
    // "without asking", "without approval", "without a person's say" (but "never post without approval" keeps the check)
    if (w === 'without' && within(words, i, 4, CHECKS) && !before(words, i, 4, NEGATE)) return `${gate}“without …” a check is not something a lesson can teach.`;
    // "never ask for approval", "no need for a review", "don't ask a lead first"
    if (w === 'never' || w === 'dont' || w === 'no') {
      const ahead = words.slice(i + 1, i + 6);
      const objectAt = ahead.findIndex((x, k) => APPROVAL_OBJECTS.has(x) && !AFTER_WITHOUT.has(ahead[k - 1] ?? ''));
      if (!ahead.slice(0, 3).some((x) => KEEPS.has(x)) && (objectAt !== -1 || (ahead.some((x) => x === 'ask' || x === 'asking') && ahead.some((x) => ASK_WHO.has(x))))) return `${gate}Asking first is not something a lesson can switch off.`;
    }
    // "do not ask the lead for approval", "stop asking for approval", "do not wait for confirmation", "no longer ask", "instead of asking"
    if (NEGATE.has(w) && w !== 'without' && !before(words, i, 2, NEGATE)) {
      const ahead = words.slice(i + 1, i + 8);
      const at = ahead.findIndex((x, k) => k < 4 && ASK_WAIT.has(x));
      if (at !== -1 && !ahead.slice(0, at).some((x) => KEEPS.has(x)) && ahead.slice(at + 1, at + 7).some((x) => SAY_OBJECTS.has(x))) return `${gate}Asking first is not something a lesson can switch off.`;
    }
    // "go ahead and post": acting without waiting for a person's say
    if (w === 'go' && words[i + 1] === 'ahead' && within(words, i + 1, 4, ACTION) && !negatedBefore(words, i, 3)) return `${gate}“go ahead” and act is not something a lesson can teach: a person has the say first.`;
    // "post messages directly", "send it automatically"
    if (ACTION.has(w) && !negatedBefore(words, i, 3)) {
      const how = words.slice(i + 1, i + 5).find((x) => IMMEDIATELY.has(x));
      if (how !== undefined) return `${gate}Acting “${how}” is not something a lesson can teach: a person has the say first.`;
    }
    // "auto approve", "approve it yourself", "self approve"
    if (w === 'autoapprove' || w === 'autoapproved' || (w === 'auto' && (words[i + 1] === 'approve' || words[i + 1] === 'approved')) || (w === 'self' && words[i + 1] === 'approve') || (w === 'approve' && (words[i + 1] === 'it' || words[i + 1] === 'them' || words[i + 1] === 'your' || words[i + 1] === 'its') && within(words, i, 3, new Set(['yourself', 'own', 'itself'])))) {
      return `${gate}A bot cannot approve its own work.`;
    }
    // a secret in a message: "share the password", "answer with the API key", unless it says never
    if (REVEAL.has(w)) {
      for (let k = i + 1; k <= i + 5 && k < words.length; k += 1) {
        const x = words[k] as string;
        const secret = SECRET.has(x) || ((x === 'key' || x === 'keys') && KEY_KINDS.has(words[k - 1] ?? ''));
        if (secret && !negatedBefore(words, i, 4)) return 'A lesson cannot tell the bot to put a password, key or token into a message. Say what to do instead.';
      }
    }
  }
  return null;
}

const AS = new Set(['as']);
const AFTER_WITHOUT = new Set(['without', 'before', 'until', 'unless']);

const RULE_NEGATION = /\b(?:don'?t|do not|dont|never|not|no|won'?t|wouldn'?t|shouldn'?t|can'?t|cannot|without|rather than|instead of|nothing|neither|nor|stop)\b/;
const RULE_REQUESTS: readonly string[] = [
  // "make that a rule", "turn this into a rule", "add it as a new rule", "save that as a rule"
  String.raw`\b(?:make|turn|add|save|record|file|promote)\s+(?:that|this|it)\b[^.!?\n;]{0,24}?\b(?:an?|the)\s+(?:new\s+)?rule\b`,
  // "that should be a rule"
  String.raw`\b(?:that|this|it)\s+(?:should|must|needs to|ought to)\s+(?:be|become)\s+(?:an?|the)\s+(?:new\s+)?rule\b`,
  // "make that rule" is not English; "make this a standing rule" is
  String.raw`\bmake\s+(?:that|this|it)\s+(?:an?\s+)?(?:standing\s+)?rule\b`,
];

/**
 * Says "make that a rule": the person asked for the lesson to become a rule, in their own words. Looked for in their latest message, never taken from the model's say-so. A request is the verb
 * (make, turn, add, save, record, file) with "that", "this" or "it" and "a rule"; a negation just before it ("please don't make that a rule", "never make that a rule") means the opposite; "keep the
 * rules short" or "record the new rules we discussed" are not requests.
 */
export function asksForRule(personText: string): boolean {
  const lower = personText.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'");
  for (const source of RULE_REQUESTS) {
    for (const m of lower.matchAll(new RegExp(source, 'g'))) {
      const from = Math.max(0, m.index - 40);
      // only the same sentence counts: a "no." that ended an earlier sentence does not cancel this one
      const lead = lower.slice(from, m.index).split(/[.!?\n;]/).pop() as string;
      if (!RULE_NEGATION.test(lead)) return true;
    }
  }
  return false;
}

// ---- the text of each file --------------------------------------------------------------------------------------------------------------------------------------------------

const eolOf = (content: string): string => (content.includes('\r\n') ? '\r\n' : '\n');

/** BOT.md with one more rule under `RULES_HEADING` (the heading is added at the end when the file has none). Null when the same rule is already there. */
export function withRule(botMd: string, rule: string): string | null {
  const eol = eolOf(botMd);
  const bullet = `- ${rule.replace(/\s+/g, ' ').trim()}`;
  const lines = botMd.replace(/\s+$/, '').split(/\r\n|\r|\n/);
  const ruleWords = lessonWords(rule);
  const at = lines.findIndex((l) => l.trim() === RULES_HEADING);
  if (at === -1) return `${lines.join(eol)}${eol}${eol}${RULES_HEADING}${eol}${eol}${bullet}${eol}`;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  const existing = lines.slice(at + 1, end).filter((l) => l.startsWith('- '));
  if (existing.some((l) => similarity(ruleWords, lessonWords(l.slice(2))) >= REPEAT_SIMILARITY)) return null;
  let insertAt = end;
  while (insertAt > at + 1 && (lines[insertAt - 1] as string).trim() === '') insertAt -= 1;
  const after = lines.slice(end);
  const next = after.length === 0 ? [...lines.slice(0, insertAt), bullet] : [...lines.slice(0, insertAt), bullet, '', ...after];
  return `${next.join(eol)}${eol}`;
}

/** The rules already in BOT.md (the bullets under `RULES_HEADING`), for the check "this is already a rule". */
export function rulesOf(botMd: string): string[] {
  const lines = botMd.split(/\r\n|\r|\n/);
  const at = lines.findIndex((l) => l.trim() === RULES_HEADING);
  if (at === -1) return [];
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const l = lines[i] as string;
    if (/^#{1,6}\s/.test(l)) break;
    if (l.startsWith('- ')) out.push(l.slice(2).trim());
  }
  return out;
}

/** BOT.md with the line that names the scenario set (`evals:` with `set` and `minScore`) added to its frontmatter. Null when the file cannot take it (no closing line, or it parses badly after). */
export function withEvalsBlock(botMd: string, set: string): string | null {
  const eol = eolOf(botMd);
  const lines = botMd.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  if (lines[0] !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l === '---');
  if (end === -1) return null;
  const next = [...lines.slice(0, end), 'evals:', `  set: ${set}`, `  minScore: ${String(LESSON_EVAL_MIN_SCORE)}`, ...lines.slice(end)].join(eol);
  const parsed = parseBotMd(next);
  return parsed.ok && parsed.frontmatter.evals?.set === set ? next : null;
}

// ---- the eval case ------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface CaseInput {
  /** The lesson, for the id and the reason the case is there. */
  lesson: string;
  date: string;
  /** What to ask the bot so the lesson shows. */
  question: string;
  mustMention?: readonly string[] | undefined;
  mustNotMention?: readonly string[] | undefined;
  mustCall?: readonly string[] | undefined;
  mustNotCall?: readonly string[] | undefined;
}

/**
 * The id of the case a lesson makes: the same text always gives the same id, so filing it twice cannot add it twice. It is the hash of the whole normalised text (case, spacing and punctuation
 * do not matter; every word does, "not" and words in any script included), so "Use metric units" and "Never use metric units" can never share one case.
 */
export const caseIdOf = (lesson: string): string => `lesson-${createHash('sha256').update(tokens(lesson).join(' ')).digest('hex').slice(0, 8)}`;

/**
 * Whether the scenario set already holds a case for this lesson: one with the same id, or one made for a lesson that says the same thing (the rationale of a case holds the lesson it was made
 * from, and the repeat rule of `similarity` decides). So a lesson told again in other words does not add a second copy of its test; an opposite lesson does add its own.
 */
export function hasCaseForLesson(existing: string | null, lesson: string): boolean {
  if (existing === null) return false;
  const loaded = parseBotEvalSet(existing);
  if (!loaded.ok) return false;
  const id = caseIdOf(lesson);
  const words = lessonWords(lesson);
  return loaded.set.cases.some((c) => c.id === id || similarity(words, lessonWords(c.rationale.replace(/^From a correction on \d{4}-\d{2}-\d{2}: /, ''))) >= REPEAT_SIMILARITY);
}

/** The scenario the lesson stands for, checked against the real shape (`BotEvalCase`): a case must assert something a program can check. */
export function evalCaseFor(input: CaseInput): { ok: true; case: BotEvalCase } | { ok: false; message: string } {
  const expect: Record<string, unknown> = {};
  if (input.mustMention && input.mustMention.length > 0) expect['mentions'] = [...input.mustMention];
  if (input.mustNotMention && input.mustNotMention.length > 0) expect['notMentions'] = [...input.mustNotMention];
  const calls: Record<string, unknown> = {};
  if (input.mustCall && input.mustCall.length > 0) calls['required'] = [...input.mustCall];
  if (input.mustNotCall && input.mustNotCall.length > 0) calls['forbidden'] = [...input.mustNotCall];
  if (Object.keys(calls).length > 0) expect['toolCalls'] = calls;
  const parsed = BotEvalCase.safeParse({
    id: caseIdOf(input.lesson),
    question: input.question.trim(),
    expect,
    rationale: `From a correction on ${input.date}: ${input.lesson.replace(/\s+/g, ' ').trim()}`.slice(0, 300),
  });
  if (parsed.success) return { ok: true, case: parsed.data };
  return { ok: false, message: parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'case'}: ${i.message}`).join('; ') };
}

/**
 * The scenario set file with the case added. A missing file becomes a new set; an existing one is edited in place (comments and order stay) and checked again with the real parser. A case
 * already in the set (same id) is not added twice (`added: false`). Refuses a set file that does not load, one that is full, and one that would grow past the size the harness reads.
 */
export function withEvalCase(existing: string | null, set: string, c: BotEvalCase): { ok: true; content: string; added: boolean } | { ok: false; message: string } {
  const finish = (content: string): { ok: true; content: string; added: boolean } | { ok: false; message: string } => {
    if (content.length > BOT_EVAL_SET_MAX_CHARS) return { ok: false, message: `The scenario set ${set} would be larger than ${String(BOT_EVAL_SET_MAX_CHARS / 1024)} KB.` };
    const again = parseBotEvalSet(content);
    if (!again.ok) return { ok: false, message: `The scenario set would not load afterwards (${again.message}).` };
    if (again.set.set !== set) return { ok: false, message: `The scenario set file is named ${again.set.set}, not ${set}.` };
    return { ok: true, content, added: true };
  };
  if (existing === null) return finish(new Document({ schema: 1, set, cases: [c] }).toString({ lineWidth: 0 }));
  const loaded = parseBotEvalSet(existing);
  if (!loaded.ok) return { ok: false, message: `The scenario set ${set} does not load (${loaded.message}), so a case cannot be added to it. A person has to fix that file first.` };
  if (loaded.set.cases.some((x) => x.id === c.id)) return { ok: true, content: existing, added: false };
  if (loaded.set.cases.length >= BOT_EVAL_SET_MAX_CASES) return { ok: false, message: `The scenario set ${set} already has ${String(BOT_EVAL_SET_MAX_CASES)} cases, the most it can hold.` };
  const doc = parseDocument(existing);
  doc.addIn(['cases'], doc.createNode(c));
  return finish(doc.toString({ lineWidth: 0 }));
}

export { botEvalSetPath };
