import { compileSpanPattern, type DlpDetectorSetting, type DlpRuleSetting } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-utils/src/linear.ts';
import { SCAN_LIMIT_RULE, inspect, scan, type DlpPolicySnapshot } from '../src/dlp.ts';
import { snapshotOf, toPolicy } from '../src/policy.ts';

// P10-04: what an admin's choices change. Each detector can follow the preset, be ignored, redact, hold for approval or block; custom patterns add to
// them; the personal-data detectors are off until switched on. The text that was matched never appears in a result's rule names.

const KEY = 'AKIAIOSFODNN7EXAMPLE';
const policy = (detectors: Record<string, DlpDetectorSetting> = {}, rules: { name: string; pattern: string; action?: DlpRuleSetting; ignoreCase?: boolean }[] = []): DlpPolicySnapshot => ({
  detectors: new Map(Object.entries(detectors)),
  rules: rules.map((r) => {
    const compiled = compileSpanPattern(r.pattern, r.ignoreCase ?? false);
    if (!compiled.ok) throw new Error(compiled.reason);
    return { name: r.name, program: compiled.program, action: r.action ?? 'redact' };
  }),
});

describe('the built-in detectors under a policy', () => {
  it('keeps the old behaviour when no policy is given, and leaves the personal-data detectors off', () => {
    expect(scan('mail me at bob@example.com or +44 20 7946 0958, ref DB_PASSWORD=Tr0ub4dor&3x')).toEqual([]);
  });

  it('applies the action an admin chose to a detector, whatever the preset says', () => {
    const text = `deploy with ${KEY} now`;
    expect(inspect(text, 'standard', 'preset', policy({ 'api-key': 'block' }))).toMatchObject({ outcome: 'block', text, rules: ['api-key'] });
    expect(inspect(text, 'standard', 'preset', policy({ 'api-key': 'require_approval' }))).toMatchObject({ outcome: 'require_approval', text: 'deploy with [redacted:api-key] now' });
    expect(inspect(text, 'customer-facing', 'preset', policy({ 'api-key': 'redact' }))).toMatchObject({ outcome: 'redact', text: 'deploy with [redacted:api-key] now' });
    expect(inspect(text, 'standard', 'preset', policy({ 'api-key': 'allow' }))).toMatchObject({ outcome: 'allow', rules: [] });
    expect(inspect(text, 'customer-facing', 'preset', policy({ 'api-key': 'preset' }))).toMatchObject({ outcome: 'block' });
  });

  it('lets the strongest finding decide when several are in one text', () => {
    const text = `${KEY} and 4111 1111 1111 1111`;
    const result = inspect(text, 'standard', 'preset', policy({ 'api-key': 'redact', 'card-number': 'block' }));
    expect(result.outcome).toBe('block');
    expect(result.text).toBe(text);
    expect(result.rules).toEqual(['api-key', 'card-number']);
  });

  it('a person approving the call lets it through except for a finding set to block', () => {
    const text = `${KEY} and 4111 1111 1111 1111`;
    expect(inspect(text, 'standard', 'approved', policy({ 'api-key': 'require_approval' })).outcome).toBe('allow');
    expect(inspect(text, 'standard', 'approved', policy({ 'api-key': 'require_approval', 'card-number': 'block' })).outcome).toBe('block');
  });

  it('holds a redaction for a person when the bot asked for it', () => {
    expect(inspect(`use ${KEY}`, 'standard', 'hold', policy()).outcome).toBe('require_approval');
  });

  it('finds the personal-data kinds once they are switched on', () => {
    const on = policy({ 'email-address': 'redact', 'phone-number': 'redact', iban: 'redact' });
    const text = 'mail bob@example.com, call +44 20 7946 0958, pay GB82 WEST 1234 5698 7654 32';
    const result = inspect(text, 'standard', 'preset', on);
    expect(result.rules).toEqual(['email-address', 'phone-number', 'iban']);
    expect(result.text).toBe('mail [redacted:email-address], call [redacted:phone-number], pay [redacted:iban]');
  });

  it('does not take an invalid IBAN, a short number or a plain version string for personal data', () => {
    const on = policy({ 'email-address': 'redact', 'phone-number': 'redact', iban: 'redact' });
    expect(inspect('pay GB82 WEST 1234 5698 7654 33 and call +12345 or v1.2.3 at host@localhost', 'standard', 'preset', on).rules).toEqual([]);
  });

  it('hides the value of a password or secret set in code and keeps its name readable', () => {
    const on = policy({ 'secret-assignment': 'redact' });
    expect(inspect('DB_PASSWORD=Tr0ub4dor&3x and api_key: "k9d82nf0s7sd"', 'standard', 'preset', on).text).toBe('DB_PASSWORD=[redacted:secret-assignment] and api_key: "[redacted:secret-assignment]"');
  });

  it('ignores a secret-looking assignment that is only code', () => {
    const on = policy({ 'secret-assignment': 'redact' });
    for (const code of ['password = process.env.DB_PASSWORD', 'token: string', 'secret = ${SECRET}', 'const token = getToken()', 'password: required', 'secret = xxxxxxxxxx']) {
      expect(inspect(code, 'standard', 'preset', on).rules, code).toEqual([]);
    }
  });
});

describe('custom rules', () => {
  it('redact, hold or block on a pattern the admin wrote, and carry the rule name', () => {
    const text = 'ticket CUST-123456 is open';
    expect(inspect(text, 'standard', 'preset', policy({}, [{ name: 'customer-id', pattern: 'CUST-[0-9]{6}' }]))).toMatchObject({ outcome: 'redact', text: 'ticket [redacted:customer-id] is open', rules: ['customer-id'] });
    expect(inspect(text, 'standard', 'preset', policy({}, [{ name: 'customer-id', pattern: 'CUST-[0-9]{6}', action: 'block' }])).outcome).toBe('block');
    expect(inspect(text, 'customer-facing', 'preset', policy({}, [{ name: 'customer-id', pattern: 'CUST-[0-9]{6}', action: 'preset' }])).outcome).toBe('block');
    expect(inspect(text, 'standard', 'preset', policy({}, [{ name: 'customer-id', pattern: 'cust-[0-9]{6}', ignoreCase: true }])).outcome).toBe('redact');
    expect(inspect(text, 'standard', 'preset', policy({}, [{ name: 'customer-id', pattern: 'cust-[0-9]{6}' }])).outcome).toBe('allow');
  });

  it('cover a longer built-in finding once, not twice, when they overlap', () => {
    const result = inspect(`key ${KEY}`, 'standard', 'preset', policy({}, [{ name: 'aws-ish', pattern: 'AKIA[0-9A-Z]{16}' }]));
    expect(result.findings).toHaveLength(1);
    expect(result.text.startsWith('key [redacted:')).toBe(true);
  });

  it('never put the matched text in the names a result carries', () => {
    const result = inspect(`ticket CUST-123456 and ${KEY}`, 'standard', 'preset', policy({}, [{ name: 'customer-id', pattern: 'CUST-[0-9]{6}' }]));
    expect(JSON.stringify(result.rules)).not.toMatch(/123456|AKIA/);
  });
});

describe('text with invisible characters in it', () => {
  it('finds a key that was split with zero-width characters, and hides the invisible characters with it', () => {
    const split = `deploy AKIA\u200BIOSFOD\u2060NN7EXA\uFEFFMPLE now`;
    const result = inspect(split, 'standard', 'preset', policy());
    expect(result.rules).toEqual(['api-key']);
    expect(result.text).toBe('deploy [redacted:api-key] now');
    expect(result.text).not.toMatch(/[\u200B\u2060\uFEFF]/);
  });

  it('also catches a card number, a custom rule and a private-key header written that way', () => {
    expect(inspect('4111\u200B 1111 1111\u200D 1111', 'standard', 'preset', policy()).rules).toEqual(['card-number']);
    expect(inspect('CUST-\u200B123\u200B456', 'standard', 'preset', policy({}, [{ name: 'customer-id', pattern: 'CUST-[0-9]{6}' }])).rules).toEqual(['customer-id']);
    expect(inspect('-----BEGIN\u200B PRIVATE KEY-----', 'standard', 'preset', policy()).rules).toEqual(['private-key']);
  });

  it('leaves text without invisible characters exactly as it was, and a lone invisible character alone', () => {
    expect(inspect('plain words', 'standard', 'preset', policy())).toMatchObject({ outcome: 'allow', text: 'plain words' });
    expect(inspect('a\u200Bb', 'standard', 'preset', policy())).toMatchObject({ outcome: 'allow', text: 'a\u200Bb' });
  });

  it('keeps the text around a finding intact, with the offsets right after an invisible character before it', () => {
    const result = inspect(`\u200B\u200Bhi \u{1F600} AKIAIOSFODNN7EXAMPLE bye`, 'standard', 'preset', policy());
    expect(result.text).toBe('\u200B\u200Bhi \u{1F600} [redacted:api-key] bye');
  });
});

describe('the work a call may spend on custom rules', () => {
  const rule = [{ name: 'mail', pattern: '[a-z]+@[a-z]+\\.com' }];

  it('blocks, as a scan-limit finding, text the rules cannot be read over within the budget', () => {
    const snapshot = { ...policy({}, rule), budget: { steps: 1000, exhausted: false } };
    const result = inspect('a'.repeat(50_000), 'standard', 'preset', snapshot);
    expect(result.outcome).toBe('block');
    expect(result.rules).toEqual([SCAN_LIMIT_RULE]);
  });

  it('shares one budget across the texts of one call, so many small texts cannot add up to a lot of work', () => {
    const snapshot = { ...policy({}, rule), budget: { steps: 20_000, exhausted: false } };
    const outcomes = Array.from({ length: 50 }, () => inspect('b'.repeat(100), 'standard', 'preset', snapshot).outcome);
    expect(outcomes[0]).toBe('allow');
    expect(outcomes.at(-1)).toBe('block');
  });

  it('does not touch the budget when there are no custom rules', () => {
    const snapshot = { ...policy(), budget: { steps: 0, exhausted: false } };
    expect(inspect('a'.repeat(50_000), 'standard', 'preset', snapshot).outcome).toBe('allow');
  });

  it('keeps a 2 MB text under twenty class-start rules to a bounded time, and stops it with a scan-limit block', () => {
    const rules = Array.from({ length: 20 }, (_, i) => ({ name: `r${i}`, pattern: `[a-z]+@[a-z]+\\.com${i}` }));
    const snapshot = snapshotOf([], rules.map((r, i) => ({ id: String(i), name: r.name, pattern: r.pattern, ignore_case: false, action: 'redact', enabled: true, updated_at: new Date() })));
    const started = performance.now();
    const result = inspect('a'.repeat(2_000_000), 'standard', 'preset', snapshot);
    const took = performance.now() - started;
    expect(result.outcome).toBe('block');
    expect(result.rules).toEqual([SCAN_LIMIT_RULE]);
    expect(took).toBeLessThan(3000);
  });

  it('gives a snapshot built from rows a budget of its own', () => {
    expect(snapshotOf([], []).budget?.steps).toBeGreaterThan(1_000_000);
  });
});

describe('the policy as rows', () => {
  it('turns rows into a runnable snapshot, skipping a rule that is off or no longer compiles', () => {
    const snap = snapshotOf(
      [{ detector: 'api-key', action: 'block' }, { detector: 'bogus', action: 'nonsense' }],
      [
        { id: '1', name: 'on', pattern: 'ABC[0-9]+', ignore_case: false, action: 'redact', enabled: true, updated_at: new Date() },
        { id: '2', name: 'off', pattern: 'DEF[0-9]+', ignore_case: false, action: 'redact', enabled: false, updated_at: new Date() },
        { id: '3', name: 'bad', pattern: '(a+)+', ignore_case: false, action: 'redact', enabled: true, updated_at: new Date() },
      ],
    );
    expect(snap.detectors.get('api-key')).toBe('block');
    expect(snap.detectors.has('bogus')).toBe(false);
    expect(snap.rules.map((r) => r.name)).toEqual(['on']);
  });

  it('shows every built-in detector with the admin\'s choice or its default', () => {
    const view = toPolicy([{ detector: 'api-key', action: 'block' }], []);
    expect(view.detectors.find((d) => d.name === 'api-key')).toMatchObject({ action: 'block', custom: true });
    expect(view.detectors.find((d) => d.name === 'email-address')).toMatchObject({ action: 'allow', custom: false });
    expect(view.detectors.find((d) => d.name === 'card-number')).toMatchObject({ action: 'preset', custom: false });
  });
});

describe('hostile input', () => {
  const everything = policy(
    { 'secret-assignment': 'redact', 'email-address': 'redact', 'phone-number': 'redact', iban: 'redact' },
    [{ name: 'customer-id', pattern: 'CUST-[0-9]{6}' }, { name: 'ticket', pattern: '[A-Z]{2,5}-[0-9]{3,6}' }],
  );
  const shapes: [string, (n: number) => string][] = [
    ['one long run of address characters', (n) => 'a'.repeat(n)],
    ['many at-signs', (n) => 'a@'.repeat(n / 2)],
    ['digits with separators', (n) => '+1 2 3 4 5 '.repeat(n / 11)],
    ['a secret name that never gets a value', (n) => 'password '.repeat(n / 9)],
    ['upper-case letters and digits', (n) => 'GB82WEST'.repeat(n / 8)],
    ['dashes and digits', (n) => 'AB-123 '.repeat(n / 7)],
  ];
  for (const [label, build] of shapes) {
    it(`stays linear: ${label}`, () => {
      expectLinear(build, (text) => inspect(text, 'standard', 'preset', everything), { n: 40_000, label, ceilingMs: 1500 });
    });
  }
});
