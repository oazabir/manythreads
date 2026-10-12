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
}

/**
 * The detectors, in the order they run. Every quantifier is bounded (MISTAKES: an open-ended inner quantifier is how a
 * scanner becomes quadratic on hostile input), and every pattern is global so a text with several findings is covered.
 */
const DETECTORS: readonly Detector[] = [
  { name: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]{1,40}PRIVATE KEY-----/g },
  {
    name: 'api-key',
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,120}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,80}|xox[baprs]-[A-Za-z0-9-]{10,80})\b/g,
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
    for (const match of text.matchAll(detector.pattern)) {
      const value = match[0];
      const start = match.index ?? 0;
      if (detector.luhn && !luhnOk(value.replace(/[ -]/g, ''))) continue;
      found.push({ rule: detector.name, start, end: start + value.length });
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
