import { useState } from 'react';
import { DLP_CUSTOM_RULES_MAX, DLP_PATTERN_MAX_LENGTH, DLP_TEST_TEXT_MAX, DlpDetectorSetting, DlpRuleSetting, type DlpCustomRule, type DlpDetectorState, type DlpPolicy, type TestDlpResponse } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { addDlpRule, changeDlpRule, removeDlpRule, saveDlpDetector, testDlp } from '../../api/endpoints';
import { Alert, Notice, Toggle } from '../../components/ui';
import { DETECTOR_ACTION_HINTS, DETECTOR_ACTION_LABELS, RULE_ACTION_LABELS, testOutcomeWords } from './format';

const messageOf = (err: unknown): string => (isApiError(err) ? err.message : 'Something went wrong. Try again.');

/** The data-loss half of the page: the built-in detectors, the admin's own patterns, and a box to try them on. */
export function DlpSection({ policy, reload }: { policy: DlpPolicy; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>, done: string): Promise<boolean> => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      await work();
      setNote(done);
      reload();
      return true;
    } catch (err) {
      setError(messageOf(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const groups: { id: 'secrets' | 'personal'; title: string; blurb: string }[] = [
    { id: 'secrets', title: 'Secrets', blurb: 'Keys, tokens and passwords that give access to something.' },
    { id: 'personal', title: 'Personal data', blurb: 'Details about people. These are off until you switch them on.' },
  ];

  return (
    <section className="block" aria-labelledby="gr-dlp" data-testid="gr-dlp">
      <h2 className="bh" id="gr-dlp">What to do when a bot is about to send something sensitive</h2>
      <div className="block-body">
        {error ? <Alert>{error}</Alert> : null}
        {note ? <Notice>{note}</Notice> : null}

        {groups.map((g) => (
          <div key={g.id} className="gr-group">
            <h3 className="gr-h3">{g.title}</h3>
            <p className="fld-hint">{g.blurb}</p>
            <ul className="rows">
              {policy.detectors
                .filter((d) => d.group === g.id)
                .map((d) => (
                  <DetectorRow key={d.name} d={d} busy={busy} onChange={(action) => void run(() => saveDlpDetector(d.name, { action }), `${d.label}: ${DETECTOR_ACTION_LABELS[action].toLowerCase()}.`)} />
                ))}
            </ul>
          </div>
        ))}

        <div className="gr-group">
          <h3 className="gr-h3">Your own patterns</h3>
          <p className="fld-hint">
            For things only your company has, such as internal ticket codes or customer ids. A pattern is a short expression like <code>ACME-[0-9]&#123;6&#125;</code>; it can use
            letters, digits, groups, <code>|</code>, <code>?</code>, <code>*</code>, <code>+</code> and <code>&#123;3,6&#125;</code>, but not look-ahead or back-references. Up to {DLP_CUSTOM_RULES_MAX} patterns.
          </p>
          {policy.rules.length === 0 ? <p className="fld-hint" data-testid="gr-no-rules">No patterns yet.</p> : null}
          <ul className="rows">
            {policy.rules.map((r) => (
              <RuleRow key={r.id} rule={r} busy={busy} run={run} />
            ))}
          </ul>
          <NewRule busy={busy} full={policy.rules.length >= DLP_CUSTOM_RULES_MAX} run={run} />
        </div>

        <TestBox />
      </div>
    </section>
  );
}

function DetectorRow({ d, busy, onChange }: { d: DlpDetectorState; busy: boolean; onChange: (a: DlpDetectorSetting) => void }) {
  return (
    <li className="srow gr-row" data-detector={d.name} data-action={d.action}>
      <div>
        <div>{d.label}</div>
        <div className="d">{d.description}</div>
        <div className="d">{DETECTOR_ACTION_HINTS[d.action]}</div>
      </div>
      <select aria-label={`What to do with ${d.label.toLowerCase()}`} value={d.action} disabled={busy} onChange={(e) => onChange(DlpDetectorSetting.parse(e.target.value))}>
        {DlpDetectorSetting.options.map((o) => (
          <option key={o} value={o}>{DETECTOR_ACTION_LABELS[o]}</option>
        ))}
      </select>
    </li>
  );
}

type Run = (work: () => Promise<unknown>, done: string) => Promise<boolean>;

function RuleRow({ rule, busy, run }: { rule: DlpCustomRule; busy: boolean; run: Run }) {
  const [editing, setEditing] = useState(false);
  const [pattern, setPattern] = useState(rule.pattern);
  const [ignoreCase, setIgnoreCase] = useState(rule.ignoreCase);

  return (
    <li className="srow gr-row" data-rule={rule.name} data-enabled={rule.enabled}>
      <div className="gr-rule-main">
        <div>
          <b>{rule.name}</b>
          {rule.enabled ? null : <span className="gr-off"> (off)</span>}
        </div>
        {editing ? (
          <div className="fld">
            <label htmlFor={`gr-pat-${rule.id}`}>Pattern</label>
            <input id={`gr-pat-${rule.id}`} value={pattern} maxLength={DLP_PATTERN_MAX_LENGTH} onChange={(e) => setPattern(e.target.value)} />
            <label className="gr-check">
              <input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} /> Ignore capital letters
            </label>
            <div className="gr-actions">
              <button
                type="button"
                className="btn primary"
                disabled={busy || pattern.trim() === ''}
                onClick={() => void run(() => changeDlpRule(rule.id, { pattern, ignoreCase }), `Saved ${rule.name}.`).then((ok) => ok && setEditing(false))}
              >
                Save
              </button>
              <button type="button" className="btn quiet" onClick={() => { setEditing(false); setPattern(rule.pattern); setIgnoreCase(rule.ignoreCase); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <code className="gr-pattern" data-vt-mask>{rule.pattern}{rule.ignoreCase ? '  (any case)' : ''}</code>
        )}
      </div>
      <div className="gr-rule-side">
        <select aria-label={`What to do with ${rule.name}`} value={rule.action} disabled={busy} onChange={(e) => void run(() => changeDlpRule(rule.id, { action: DlpRuleSetting.parse(e.target.value) }), `Saved ${rule.name}.`)}>
          {DlpRuleSetting.options.map((o) => (
            <option key={o} value={o}>{RULE_ACTION_LABELS[o]}</option>
          ))}
        </select>
        <Toggle label={`Use ${rule.name}`} checked={rule.enabled} disabled={busy} onChange={(v) => void run(() => changeDlpRule(rule.id, { enabled: v }), `${rule.name} is ${v ? 'on' : 'off'}.`)} />
        {editing ? null : <button type="button" className="btn quiet" onClick={() => setEditing(true)}>Edit</button>}
        <button type="button" className="btn quiet" disabled={busy} onClick={() => void run(() => removeDlpRule(rule.id), `Removed ${rule.name}.`)}>Remove</button>
      </div>
    </li>
  );
}

function NewRule({ busy, full, run }: { busy: boolean; full: boolean; run: Run }) {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [action, setAction] = useState<DlpRuleSetting>('redact');
  if (full) return <p className="fld-hint">You have reached the limit of {DLP_CUSTOM_RULES_MAX} patterns. Remove one to add another.</p>;
  return (
    <form
      className="gr-new"
      aria-label="Add a pattern"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => addDlpRule({ name, pattern, ignoreCase, action, enabled: true }), `Added ${name}.`).then((ok) => {
          if (ok) {
            setName('');
            setPattern('');
          }
        });
      }}
    >
      <div className="fld">
        <label htmlFor="gr-new-name">Name</label>
        <input id="gr-new-name" value={name} maxLength={40} placeholder="customer-id" onChange={(e) => setName(e.target.value.toLowerCase())} />
        <div className="fld-hint">Shown in the audit log and in place of a hidden match. Lower-case letters, digits, dashes.</div>
      </div>
      <div className="fld">
        <label htmlFor="gr-new-pattern">Pattern</label>
        <input id="gr-new-pattern" value={pattern} maxLength={DLP_PATTERN_MAX_LENGTH} placeholder="CUST-[0-9]{6}" onChange={(e) => setPattern(e.target.value)} />
      </div>
      <label className="gr-check">
        <input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} /> Ignore capital letters
      </label>
      <div className="fld">
        <label htmlFor="gr-new-action">When it is found</label>
        <select id="gr-new-action" value={action} onChange={(e) => setAction(DlpRuleSetting.parse(e.target.value))}>
          {DlpRuleSetting.options.map((o) => (
            <option key={o} value={o}>{RULE_ACTION_LABELS[o]}</option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn primary" disabled={busy || name === '' || pattern.trim() === ''}>Add pattern</button>
    </form>
  );
}

/** Tries the saved settings on a piece of text. The text is checked and forgotten: it is not saved, logged or sent anywhere else. */
function TestBox() {
  const [text, setText] = useState('');
  const [pattern, setPattern] = useState('');
  const [result, setResult] = useState<TestDlpResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await testDlp({ text, preset: 'standard', ...(pattern.trim() === '' ? {} : { rule: { name: 'test', pattern: pattern.trim(), ignoreCase: false, action: 'redact' } }) }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gr-group" data-testid="gr-test">
      <h3 className="gr-h3">Try it</h3>
      <p className="fld-hint">Paste some text to see what would happen to it. It is checked here and forgotten: nothing is saved, logged or sent on.</p>
      {error ? <Alert>{error}</Alert> : null}
      <div className="fld">
        <label htmlFor="gr-test-text">Text to check</label>
        <textarea id="gr-test-text" rows={5} maxLength={DLP_TEST_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} data-vt-mask />
      </div>
      <div className="fld">
        <label htmlFor="gr-test-pattern">A pattern to try as well (optional, not saved)</label>
        <input id="gr-test-pattern" value={pattern} maxLength={DLP_PATTERN_MAX_LENGTH} onChange={(e) => setPattern(e.target.value)} />
      </div>
      <button type="button" className="btn primary" disabled={busy || text === ''} onClick={() => void check()}>Check</button>
      {result ? (
        <div className="gr-result" data-testid="gr-result" data-outcome={result.outcome}>
          <p>{testOutcomeWords(result)}</p>
          {result.outcome === 'redact' || result.outcome === 'require_approval' ? <pre className="gr-preview" data-vt-mask>{result.text}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
