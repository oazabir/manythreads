import { LLM_GUARD_PRESETS, type LlmGuardOutcome, type LlmGuardPreset } from '@manythreads/shared';

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
  /**
   * Where the finding really ends, when the pattern only finds its start (a PEM block: the header is a pattern, the body and
   * footer are not). One locator per `scan`, so it may keep state to stay linear across many matches.
   */
  locator?: () => (text: string, start: number, matched: string) => number;
}

/** How much of a key block is redacted when its footer is missing or too far away to be the same block (a 4096-bit RSA key is ~3.3 KB). */
const PEM_BODY_LIMIT = 16_384;
const PEM_FOOTER = '-----END ';

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
  },
  { name: 'bearer-token', pattern: /\bBearer[ \t]{1,4}[A-Za-z0-9._~+/=-]{20,400}/g },
  { name: 'credential-url', pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,64}:[^\s:@/]{1,64}@/gi },
  { name: 'card-number', pattern: /\b\d(?:[ -]?\d){12,18}\b/g, luhn: true },
];

export interface DlpFinding {
  /** The detector that fired. */
  rule: string;
  start: number;
  end: number;
}

export interface DlpResult {
  /** `allow` when nothing fired; otherwise the preset's action on a detection. */
  outcome: LlmGuardOutcome;
  /** The text as it may be sent: unchanged for `allow` and `block`, redacted for `redact`. */
  text: string;
  findings: DlpFinding[];
  /** The detector names that fired, in the order the detectors run, each once. */
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

/** Every detector's findings, earliest first, overlaps dropped (the first (longest at that start) match wins). */
export function scan(text: string): DlpFinding[] {
  const found: DlpFinding[] = [];
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    const locate = detector.locator?.();
    for (const match of text.matchAll(detector.pattern)) {
      const value = match[0];
      const start = match.index ?? 0;
      if (detector.luhn && !luhnOk(value.replace(/[ -]/g, ''))) continue;
      found.push({ rule: detector.name, start, end: locate ? locate(text, start, value) : start + value.length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: DlpFinding[] = [];
  for (const finding of found) {
    const last = kept[kept.length - 1];
    if (last && finding.start < last.end) continue;
    kept.push(finding);
  }
  return kept;
}

/**
 * Inspect `text` under `preset`. The preset decides what a finding means: `redact` answers the text with each span
 * replaced by `[redacted:<rule>]` and the call may continue; `block` leaves the text alone and the caller must refuse
 * the call. `require_approval` is in the vocabulary (SPEC §15) but the preset that would use it is not built yet — the
 * approvals plugin of P5-20 owns that path.
 */
export function inspect(text: string, preset: LlmGuardPreset): DlpResult {
  const findings = scan(text);
  if (findings.length === 0) return { outcome: 'allow', text, findings, rules: [] };
  const rules = DETECTORS.map((d) => d.name).filter((name) => findings.some((f) => f.rule === name));
  if (LLM_GUARD_PRESETS[preset].onDetection === 'block') return { outcome: 'block', text, findings, rules };

  let redacted = '';
  let cursor = 0;
  for (const finding of findings) {
    redacted += text.slice(cursor, finding.start) + `[redacted:${finding.rule}]`;
    cursor = finding.end;
  }
  redacted += text.slice(cursor);
  return { outcome: 'redact', text: redacted, findings, rules };
}
