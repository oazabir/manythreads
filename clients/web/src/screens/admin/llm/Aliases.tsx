import { useState } from 'react';
import { LLM_ALIASES, type LlmAlias, type LlmAliasName, type LlmProvider } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { deleteLlmAlias, setLlmAlias } from '../../../api/endpoints';
import { Alert, Notice, Toggle } from '../../../components/ui';

/*
 * Workspace → LLM → Aliases (SPEC §10.1, PLAN P5-06/P5-08). An alias is the only model vocabulary a bot knows: a BOT.md
 * says `smart`, never `claude-sonnet-4`, so a workspace can move `smart` to another provider without touching a single
 * bot definition. The eight names are the closed set from `LLM_ALIASES`, listed in the order SPEC §10.1 names them.
 *
 * `model` may carry its provider prefix (`anthropic/claude-sonnet-4`) or name a provider in the row beside it; a bare
 * model with no provider is the case the gateway skips at push time, which is why the row says so rather than failing.
 *
 * Fallbacks are the other aliases tried, in order, when this one fails. Three are allowed and an alias cannot fall back
 * to itself, so a cycle cannot be written here — LiteLLM rejects one at load, and a page should not be able to produce
 * something the proxy will refuse.
 */

const MAX_FALLBACKS = 3;

function AliasRow({
  alias,
  bound,
  providers,
  onSaved,
  onError,
}: {
  alias: LlmAliasName;
  bound: LlmAlias | undefined;
  providers: LlmProvider[];
  onSaved: (message: string) => void;
  onError: (err: unknown) => void;
}) {
  const [model, setModel] = useState(bound?.model ?? '');
  const [providerId, setProviderId] = useState(bound?.providerId ?? '');
  const [fallbacks, setFallbacks] = useState<LlmAliasName[]>(bound?.fallbacks ?? []);
  const [busy, setBusy] = useState(false);

  const others = LLM_ALIASES.filter((a) => a !== alias);
  const enabled = providers.filter((p) => p.enabled);

  function toggleFallback(other: LlmAliasName, on: boolean) {
    if (on && fallbacks.length >= MAX_FALLBACKS) return;
    setFallbacks(on ? [...fallbacks, other] : fallbacks.filter((f) => f !== other));
  }

  async function save() {
    setBusy(true);
    try {
      // Order is the order they were switched on, which is the order LiteLLM tries them in.
      await setLlmAlias(alias, { model: model.trim(), ...(providerId ? { providerId } : {}), fallbacks });
      onSaved(`The ${alias} alias is bound to ${model.trim()}.`);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function unbind() {
    setBusy(true);
    try {
      await deleteLlmAlias(alias);
      setModel('');
      setProviderId('');
      setFallbacks([]);
      onSaved(`The ${alias} alias is unbound.`);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  const dirty = model.trim() !== (bound?.model ?? '') || providerId !== (bound?.providerId ?? '') || fallbacks.join(',') !== (bound?.fallbacks ?? []).join(',');

  return (
    <tr data-alias={alias}>
      <td data-label="Alias"><span className="mono">{alias}</span></td>
      <td data-label="Model">
        <input
          aria-label={`${alias} model`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="anthropic/claude-sonnet-4"
          maxLength={200}
        />
      </td>
      <td data-label="Provider">
        <select aria-label={`${alias} provider`} value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          <option value="">from the model name</option>
          {enabled.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </td>
      <td data-label="Fallbacks">
        <div className="alias-fallbacks">
          {others.map((o) => (
            <Toggle
              key={o}
              label={`${alias} falls back to ${o}`}
              checked={fallbacks.includes(o)}
              disabled={!fallbacks.includes(o) && fallbacks.length >= MAX_FALLBACKS}
              onChange={(v) => toggleFallback(o, v)}
            />
          ))}
        </div>
        <span className="faint mono">{fallbacks.length ? fallbacks.join(' → ') : 'none'}</span>
      </td>
      <td data-label="State">
        {bound ? <span className="kind h">bound</span> : <span className="kind ru">unbound</span>}
      </td>
      <td data-label="Actions" className="d-cell">
        <button type="button" className="btn primary" disabled={busy || model.trim() === '' || !dirty} onClick={() => void save()}>Save</button>
        {bound ? <button type="button" className="btn" disabled={busy} onClick={() => void unbind()}>Unbind</button> : null}
      </td>
    </tr>
  );
}

export function AliasesSection({ providers, aliases, reload }: { providers: LlmProvider[]; aliases: LlmAlias[]; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const byAlias = new Map(aliases.map((a) => [a.alias, a]));

  return (
    <section className="block" aria-labelledby="llm-aliases">
      <h2 className="bh" id="llm-aliases">Aliases</h2>
      <div className="block-body">
        <p className="lede">
          What a bot asks for by name. An unbound alias fails a run that asks for it, which is why the row says so before
          anyone finds out the hard way.
        </p>
        {error ? <Alert>{error}</Alert> : null}
        {note ? <Notice>{note}</Notice> : null}
        <div className="table-wrap">
          <table className="table" data-testid="llm-aliases">
            <thead>
              <tr>
                <th scope="col">Alias</th>
                <th scope="col">Model</th>
                <th scope="col">Provider</th>
                <th scope="col">Fallbacks</th>
                <th scope="col">State</th>
                <th scope="col"><span className="faint">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {LLM_ALIASES.map((alias) => (
                <AliasRow
                  key={alias}
                  alias={alias}
                  bound={byAlias.get(alias)}
                  providers={providers}
                  onSaved={(m) => {
                    setError(null);
                    setNote(m);
                    reload();
                  }}
                  onError={(err) => {
                    setNote(null);
                    setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
