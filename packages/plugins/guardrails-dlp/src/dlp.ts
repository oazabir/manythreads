import {
  DLP_DETECTORS,
  LLM_GUARD_PRESETS,
  findSpans,
  prepareText,
  type DlpDetectorSetting,
  type DlpRuleSetting,
  type GateProgram,
  type LlmGuardOutcome,
  type LlmGuardPreset,
  type SpanBudget,
} from '@manythreads/shared';

// The gateway's pre-call hook (SPEC §15, PLAN P5-07 "pre-call DLP hook with `standard`"). Every model call the runtimes
// make passes here first: the text that would leave is scanned, and what happens to a finding is the preset's rule
// (`standard` redacts, `customer-facing` refuses). This is plain string work — no database, no network — so the hook is
// cheap enough to sit in front of every call, and a unit test can assert it on hostile input.
//
// Names, not secrets: a finding carries the detector's name and the span, never the matched text back to the caller, and
// the caller sends the redacted text (the event records the rule names only).

interface Detector {
  /** The name the event and the redaction carry (`[redacted:api-key]`). */
  name: string;
  pattern: RegExp;
  /** A checksum the match must also pass (card numbers), so a 16-digit id is not treated as a card. */
  luhn?: boolean;
  /** A further test the match must pass (answering false drops it), for shapes the pattern alone cannot tell from prose. */
  accept?: (matched: string) => boolean;
  /**
   * Where the finding really ends, when the pattern only finds its start (a PEM block: the header is a pattern, the body and
   * footer are not). One locator per `scan`, so it may keep state to stay linear across many matches.
   */
  locator?: () => (text: string, start: number, matched: string) => number;
  /** The finding is the pattern's first capture group (the value after `name =`), not the whole match: the name stays readable, the value goes. */
  valueGroup?: boolean;
}

/** How much of a key block is redacted when its footer is missing or too far away to be the same block (a 4096-bit RSA key is ~3.3 KB). */
const PEM_BODY_LIMIT = 16_384;
const PEM_FOOTER = '-----END ';

/**
 * Whether an `sk-` match is a key rather than a hyphenated word (`sk-learn-pipeline-classifier`). Real keys carry digits
 * (every OpenAI/Anthropic format does); the one digit-free shape worth catching is a single unbroken run of letters 20+ long.
 * Hyphenated prose has neither. Runs on the matched span only (at most ~515 characters), so it adds nothing superlinear.
 */
const looksLikeSkKey = (matched: string): boolean => !matched.startsWith('sk-') || /\d/.test(matched) || /^sk-[A-Za-z]{20,}$/.test(matched);

/**
 * The end of a PEM private-key block that starts at `start`: the footer's closing dashes, or a bounded stretch after the
 * header when there is no footer (a truncated paste still leaks its body). The search for the footer is `indexOf`, and the
 * last answer is reused for any later header it still precedes, so a text full of headers with no footer is scanned once —
 * not once per header (the shape that makes a naive `BEGIN[\s\S]*?END` quadratic).
 */
function pemLocator(): (text: string, start: number, matched: string) => number {
  let searchedFrom = -1;
  let footerAt = -1;
  return (text, start, matched) => {
    const bodyStart = start + matched.length;
    if (searchedFrom < 0 || bodyStart < searchedFrom || (footerAt !== -1 && footerAt < bodyStart)) {
      footerAt = text.indexOf(PEM_FOOTER, bodyStart);
      searchedFrom = bodyStart;
    }
    const limit = Math.min(text.length, start + PEM_BODY_LIMIT);
    if (footerAt === -1 || footerAt >= limit) return limit;
    const close = text.indexOf('-----', footerAt + PEM_FOOTER.length);
    return close !== -1 && close - footerAt <= 100 ? Math.min(close + 5, text.length) : Math.min(footerAt + PEM_FOOTER.length, text.length);
  };
}


/** Values a config line sets that are not secrets: a template variable, a call, a path through an object, or a plain lower-case word (`string`, `required`). */
const looksLikeSecretValue = (value: string): boolean => {
  if (/^[$%{<([]/.test(value) || value.includes('(')) return false;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(value)) return false;
  if (/^[a-z]+$/.test(value)) return false;
  return !/^(.)\1+$/.test(value);
};

/** An IBAN passes when moving its first four characters to the end and reading letters as 10..35 leaves remainder 1 when divided by 97. */
function ibanOk(matched: string): boolean {
  const compact = matched.replace(/ /g, '');
  if (compact.length < 15 || compact.length > 34) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

const phoneOk = (matched: string): boolean => {
  const digits = matched.replace(/\D/g, '').length;
  return digits >= 8 && digits <= 15;
};

/**
 * The detectors, in the order they run. Every quantifier is bounded (MISTAKES: an open-ended inner quantifier is how a
 * scanner becomes quadratic on hostile input), and every pattern is global so a text with several findings is covered.
 */
const DETECTORS: readonly Detector[] = [
  // The header finds the block; the locator extends the finding over its body and footer, so the key itself is redacted and not just its label.
  { name: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g, locator: pemLocator },
  {
    name: 'api-key',
    // `sk-` keys run long (`sk-proj-…` and `sk-ant-…` are 100–200 characters): up to 512, and no trailing boundary, so the tail
    // of a longer key is never left behind after a cap that happened to fall mid-token.
    pattern: /\bsk-[A-Za-z0-9_-]{16,512}|\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,80}|xox[baprs]-[A-Za-z0-9-]{10,80})\b/g,
    accept: looksLikeSkKey,
  },
  { name: 'bearer-token', pattern: /\bBearer[ \t]{1,4}[A-Za-z0-9._~+/=-]{20,400}/g },
  { name: 'credential-url', pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,64}:[^\s:@/]{1,64}@/gi },
  {
    name: 'secret-assignment',
    // `password = "…"`, `API_KEY: …`, `export DB_TOKEN=…`: a name that says secret, then `=` or `:`, then a value of 8 or more characters. The value is the finding.
    pattern: /\b[A-Za-z0-9_-]{0,30}(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]{0,20}["']?[ \t]{0,3}[:=][ \t]{0,3}["']?([^\s"'<>,;`]{8,200})/gi,
    valueGroup: true,
    accept: looksLikeSecretValue,
  },
  { name: 'card-number', pattern: /\b\d(?:[ -]?\d){12,18}\b/g, luhn: true },
  { name: 'email-address', pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5}\b/g },
  { name: 'phone-number', pattern: /(?<![\w+])\+\d(?:[ .()-]?\d){7,14}(?!\d)/g, accept: phoneOk },
  { name: 'iban', pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, accept: ibanOk },
];

/** Every built-in detector's name, in the order they run. */
export const DETECTOR_NAMES: readonly string[] = DETECTORS.map((d) => d.name);

export interface DlpFinding {
  /** The detector or custom rule that fired. */
  rule: string;
  start: number;
  end: number;
}

/** A finding with the setting of the detector or rule that found it (`preset`, or an action an admin chose). */
interface PolicyFinding extends DlpFinding {
  setting: DlpDetectorSetting | DlpRuleSetting;
}

/** One custom rule ready to run. */
export interface CompiledRule {
  name: string;
  program: GateProgram;
  action: DlpRuleSetting;
}

/**
 * The workspace's choices, ready to run: what each built-in detector does (a detector missing here keeps its default) and the custom rules that are
 * switched on. Built by `policy.ts` from the database; a unit test builds one by hand.
 */
export interface DlpPolicySnapshot {
  detectors: ReadonlyMap<string, DlpDetectorSetting>;
  rules: readonly CompiledRule[];
  /**
   * The work the custom rules may spend, shared by every text checked under this snapshot (a snapshot lives for one transaction, so one tool call).
   * Without it a scan gets a fresh one. When it runs out the text cannot be said to be clean: it is a `scan-limit` finding, which blocks.
   */
  budget?: SpanBudget;
}

/** Steps (see `SpanBudget`) the custom rules may spend on one call: a few hundred milliseconds of work at the most, whatever the size of the text or the rules. */
export const RULE_STEPS_PER_CALL = 10_000_000;
/** The finding made when the budget runs out; always `block`, whatever an admin chose, because the text was not read to the end. */
export const SCAN_LIMIT_RULE = 'scan-limit';

export interface DlpResult {
  /** `allow` when nothing fired; otherwise the strongest action any finding called for. */
  outcome: LlmGuardOutcome;
  /** The text as it may be sent: unchanged for `allow` and `block`, redacted for `redact` and for `require_approval` (what an approver may be shown). */
  text: string;
  findings: DlpFinding[];
  /** The detector and rule names that fired, built-ins in the order they run and then custom rules in their order, each once. */
  rules: string[];
}

/** Luhn: what separates a card number from a long id. Digits only; separators are dropped by the caller. */
function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const DEFAULT_SETTINGS: ReadonlyMap<string, DlpDetectorSetting> = new Map(DLP_DETECTORS.map((d) => [d.name, d.defaultSetting]));

/** Spans one custom rule may report in one text before the rest of the text counts as one finding. */
const RULE_SPANS_MAX = 500;

function overlapsDropped(found: PolicyFinding[]): PolicyFinding[] {
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: PolicyFinding[] = [];
  for (const finding of found) {
    const last = kept[kept.length - 1];
    if (last && finding.start < last.end) continue;
    kept.push(finding);
  }
  return kept;
}

/**
 * Characters that draw nothing (zero-width spaces and joiners, the soft hyphen, direction marks, variation selectors, a few blank letters). A secret with
 * one of these pushed into it reads the same to a person or a program that strips them, but not to a pattern, so the scan reads the text without them.
 */
// eslint-disable-next-line no-misleading-character-class -- the point of this pattern is to match combining and variation characters on their own
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\u2800\uFE00-\uFE0F\u180B-\u180D]/gu;

/** The text without its invisible characters, and the way back from a position in it to a position in the original. Null when there is nothing to remove. */
function withoutInvisible(text: string): { clean: string; back: (cleanIndex: number) => number } | null {
  INVISIBLE.lastIndex = 0;
  if (!INVISIBLE.test(text)) return null;
  INVISIBLE.lastIndex = 0;
  // segments of the clean text: it is `text` cut at every invisible run; cleanAt[i] is where segment i starts in the clean text, origAt[i] in the original
  const cleanAt: number[] = [];
  const origAt: number[] = [];
  const parts: string[] = [];
  let cursor = 0;
  let cleanLength = 0;
  for (const match of text.matchAll(INVISIBLE)) {
    const at = match.index ?? 0;
    if (at > cursor) {
      cleanAt.push(cleanLength);
      origAt.push(cursor);
      parts.push(text.slice(cursor, at));
      cleanLength += at - cursor;
    }
    cursor = at + match[0].length;
  }
  if (cursor < text.length) {
    cleanAt.push(cleanLength);
    origAt.push(cursor);
    parts.push(text.slice(cursor));
    cleanLength += text.length - cursor;
  }
  const back = (cleanIndex: number): number => {
    let lo = 0;
    let hi = cleanAt.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((cleanAt[mid] as number) <= cleanIndex) lo = mid;
      else hi = mid - 1;
    }
    return (origAt[lo] as number) + (cleanIndex - (cleanAt[lo] as number));
  };
  return { clean: parts.join(''), back };
}

/** Findings under a policy: the built-ins that are not switched off, then the custom rules; earliest first, overlaps dropped (the first, longest match at a place wins). */
function scanPolicy(text: string, policy: DlpPolicySnapshot | undefined): PolicyFinding[] {
  const folded = withoutInvisible(text);
  if (folded === null) return scanClean(text, policy);
  const { clean, back } = folded;
  if (clean === '') return [];
  // a finding covers its first character to its last, so everything drawn-nothing between them goes with it
  return scanClean(clean, policy).map((f) => ({ ...f, start: back(f.start), end: back(f.end - 1) + 1 }));
}

function scanClean(text: string, policy: DlpPolicySnapshot | undefined): PolicyFinding[] {
  const found: PolicyFinding[] = [];
  for (const detector of DETECTORS) {
    const setting = policy?.detectors.get(detector.name) ?? DEFAULT_SETTINGS.get(detector.name) ?? 'preset';
    if (setting === 'allow') continue;
    detector.pattern.lastIndex = 0;
    const locate = detector.locator?.();
    for (const match of text.matchAll(detector.pattern)) {
      const value = match[0];
      const at = match.index ?? 0;
      const group = detector.valueGroup ? match[1] : undefined;
      const matched = group ?? value;
      const start = group !== undefined ? at + value.length - group.length : at;
      if (detector.luhn && !luhnOk(matched.replace(/[ -]/g, ''))) continue;
      if (detector.accept && !detector.accept(matched)) continue;
      found.push({ rule: detector.name, start, end: locate ? locate(text, start, matched) : start + matched.length, setting });
    }
  }
  const rules = policy?.rules ?? [];
  if (rules.length > 0) {
    const budget = policy?.budget ?? { steps: RULE_STEPS_PER_CALL, exhausted: false };
    const whole: PolicyFinding[] = [{ rule: SCAN_LIMIT_RULE, start: 0, end: text.length, setting: 'block' }];
    if (budget.exhausted) return whole;
    budget.steps -= (text.length >> 2) + 1;
    if (budget.steps < 0) {
      budget.exhausted = true;
      return whole;
    }
    const prepared = prepareText(text);
    for (const rule of rules) {
      for (const span of findSpans(rule.program, prepared, RULE_SPANS_MAX, budget)) found.push({ rule: rule.name, start: span.start, end: span.end, setting: rule.action });
      if (budget.exhausted) return whole;
    }
  }
  return overlapsDropped(found);
}

/** The built-in detectors' findings under the default settings, earliest first, overlaps dropped. */
export function scan(text: string, policy?: DlpPolicySnapshot): DlpFinding[] {
  return scanPolicy(text, policy).map(({ rule, start, end }) => ({ rule, start, end }));
}

/**
 * What a finding does to the call. `preset` (the default): the preset's own rule — `standard` and its siblings redact, `customer-facing`
 * refuses. `hold`: the bot asked for a person to see it first (its `guard.rules` carries `dlp:require_approval`, SPEC §15): a finding that would be
 * redacted is `require_approval` instead, `text` is the redacted text (safe to show an approver) and the call does not leave. `approved`: a person has just
 * approved exactly this call, so the findings are let through as written — except a finding whose action is `block`, which no approval overrides.
 */
export type DlpMode = 'preset' | 'hold' | 'approved';

type Action = 'allow' | 'redact' | 'require_approval' | 'block';
const ORDER: readonly Action[] = ['allow', 'redact', 'require_approval', 'block'];

/**
 * Inspect `text` under `preset` and the workspace's `policy`. Each finding has an action: the one an admin chose for its detector or rule, or the
 * preset's when none was chosen. The strongest action decides the call: `block` leaves the text alone and the caller must refuse the call;
 * `require_approval` and `redact` answer the text with each finding replaced by `[redacted:<rule>]`; `mode` adds the hold and approved cases (see `DlpMode`).
 */
export function inspect(text: string, preset: LlmGuardPreset, mode: DlpMode = 'preset', policy?: DlpPolicySnapshot): DlpResult {
  const findings = scanPolicy(text, policy);
  if (findings.length === 0) return { outcome: 'allow', text, findings: [], rules: [] };
  const presetAction: Action = LLM_GUARD_PRESETS[preset].onDetection === 'block' ? 'block' : 'redact';
  let strongest: Action = 'allow';
  for (const finding of findings) {
    let action: Action = finding.setting === 'preset' ? presetAction : finding.setting;
    if (mode === 'hold' && action === 'redact') action = 'require_approval';
    if (mode === 'approved' && action !== 'block') action = 'allow';
    if (ORDER.indexOf(action) > ORDER.indexOf(strongest)) strongest = action;
  }
  const order = [...DETECTOR_NAMES, ...(policy?.rules ?? []).map((r) => r.name), SCAN_LIMIT_RULE];
  const rules = order.filter((name, index) => order.indexOf(name) === index && findings.some((f) => f.rule === name));
  const plain = findings.map(({ rule, start, end }) => ({ rule, start, end }));
  if (strongest === 'block' || strongest === 'allow') return { outcome: strongest, text, findings: plain, rules };

  let redacted = '';
  let cursor = 0;
  for (const finding of findings) {
    redacted += text.slice(cursor, finding.start) + `[redacted:${finding.rule}]`;
    cursor = finding.end;
  }
  redacted += text.slice(cursor);
  return { outcome: strongest, text: redacted, findings: plain, rules };
}
