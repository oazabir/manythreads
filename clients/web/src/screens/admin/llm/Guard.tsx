import { useState } from 'react';
import { LLM_GUARD_PRESETS, LLM_GUARD_PRESET_ORDER, type LlmGuardPreset, type LlmWorkspaceSettings } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { saveLlmSettings } from '../../../api/endpoints';
import { Alert, Notice, Toggle } from '../../../components/ui';

/*
 * Workspace → LLM → Guard (SPEC §15, PLAN P5-07/P5-08). The preset decides what may leave the gateway: where a call may
 * go, and what happens when the pre-call hook finds a secret or a card number in the text.
 *
 * The four presets are read from `LLM_GUARD_PRESETS` — the same record the plugin's hook obeys — so the summary beside
 * each radio is the behaviour in force, not a paraphrase of it. The allowlist is the one field that only matters under
 * `strict-egress`; it is still editable under the others (so switching presets does not lose it) but the section says
 * plainly when it is doing nothing.
 *
 * `require_approval` is a bot's choice, not a preset's: a bot whose Guard rules carry `dlp:require_approval` has a call that
 * trips the hook held in the Approvals inbox instead of redacted (P5-20). This page sets the workspace default only.
 */

export function GuardSection({ settings, reload }: { settings: LlmWorkspaceSettings; reload: () => void }) {
  const [preset, setPreset] = useState<LlmGuardPreset>(settings.preset);
  const [allowlist, setAllowlist] = useState(settings.egressAllowlist.join('\n'));
  const [caching, setCaching] = useState(settings.caching);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const hosts = allowlist
    .split(/[\n,]/)
    .map((h) => h.trim())
    .filter(Boolean)
    .slice(0, 100);

  async function save() {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      await saveLlmSettings({ preset, egressAllowlist: hosts, caching });
      setNote(`Guard set to ${LLM_GUARD_PRESETS[preset].label}.`);
      reload();
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="block" aria-labelledby="llm-guard">
      <h2 className="bh" id="llm-guard">Guard</h2>
      <div className="block-body">
        {error ? <Alert>{error}</Alert> : null}
        {note ? <Notice>{note}</Notice> : null}

        <fieldset className="preset-set" data-testid="llm-presets">
          <legend className="faint">What may leave the gateway</legend>
          {LLM_GUARD_PRESET_ORDER.map((name) => {
            const def = LLM_GUARD_PRESETS[name];
            return (
              <label key={name} className={`preset-card ${preset === name ? 'on' : ''}`} data-preset={name}>
                <input
                  type="radio"
                  name="llm-preset"
                  value={name}
                  checked={preset === name}
                  onChange={() => setPreset(name)}
                />
                <span>
                  <b>{def.label}</b>
                  <span className="d">{def.summary}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="fld">
          <label htmlFor="llm-egress">Egress allowlist</label>
          <textarea
            id="llm-egress"
            rows={4}
            value={allowlist}
            onChange={(e) => setAllowlist(e.target.value)}
            placeholder={'api.anthropic.com\nlocalhost:11434'}
          />
          <div className="fld-hint">
            {preset === 'strict-egress'
              ? hosts.length === 0
                ? 'Empty means nothing leaves this box — that is a choice, not a blank to leave.'
                : `${hosts.length} host${hosts.length === 1 ? '' : 's'} may be reached.`
              : 'Only the strict egress preset reads this list; it is kept for when you switch to it.'}
          </div>
        </div>

        <ul className="rows">
          <li className="srow">
            <div>
              <div id="llm-caching">Answer identical requests from the proxy's cache</div>
              <div className="d">Off means every call reaches the provider, which costs more and hides nothing.</div>
            </div>
            <Toggle label="Cache identical requests" checked={caching} disabled={busy} onChange={setCaching} />
          </li>
        </ul>

        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>Save guard</button>
      </div>
    </section>
  );
}
