import { useState, type FormEvent } from 'react';
import { LlmProviderKind, type LlmProvider } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { createLlmProvider, deleteLlmProvider, updateLlmProvider } from '../../../api/endpoints';
import { Alert, Field, Notice, Time, Toggle } from '../../../components/ui';

/*
 * Workspace → LLM → Model providers (SPEC §10.1, PLAN P5-06/P5-08). Where the calls go and how they authenticate.
 *
 * The key is write-only: it is sent once, stored by the kernel's secret service, and never read back — the row says only
 * whether one is stored (`hasSecret`). Clearing it is an empty field on an edit, which is the one way to remove a
 * credential without deleting the provider.
 *
 * A disabled provider stays configured but is skipped when the gateway rebuilds the model list, so turning one off is
 * how an admin takes a provider out of service without losing its endpoint.
 */

const KINDS = LlmProviderKind.options;

const kindLabel: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  azure: 'Azure OpenAI',
  bedrock: 'Amazon Bedrock',
  google: 'Google',
  ollama: 'Ollama (local)',
  openai_compatible: 'OpenAI-compatible',
};

export function ProvidersSection({ providers, reload }: { providers: LlmProvider[]; reload: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function fail(err: unknown) {
    setNote(null);
    setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      await createLlmProvider({
        name: name.trim(),
        kind,
        // A blank field is omitted rather than sent empty: the schema refuses an empty URL or an empty key.
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(apiBase.trim() ? { apiBase: apiBase.trim() } : {}),
        ...(apiVersion.trim() ? { apiVersion: apiVersion.trim() } : {}),
      });
      setName('');
      setApiKey('');
      setApiBase('');
      setApiVersion('');
      setNote('Provider added. The gateway is being brought in line.');
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(provider: LlmProvider, enabled: boolean) {
    setError(null);
    setNote(null);
    try {
      await updateLlmProvider(provider.id, { enabled });
      setNote(`${provider.name} is ${enabled ? 'on' : 'off'}.`);
      reload();
    } catch (err) {
      fail(err);
    }
  }

  async function remove(provider: LlmProvider) {
    setError(null);
    setNote(null);
    try {
      await deleteLlmProvider(provider.id);
      setNote(`${provider.name} removed.`);
      reload();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <section className="block" aria-labelledby="llm-providers">
      <h2 className="bh" id="llm-providers">Model providers</h2>
      <div className="block-body">
        {error ? <Alert>{error}</Alert> : null}
        {note ? <Notice>{note}</Notice> : null}
        {providers.length === 0 ? (
          <p className="faint" data-testid="llm-no-providers">No provider yet. Add one before binding an alias.</p>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="llm-providers">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Key</th>
                  <th scope="col">On</th>
                  <th scope="col"><span className="faint">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.id} data-provider={p.name}>
                    <td data-label="Name">{p.name}</td>
                    <td data-label="Kind" className="d-cell">{kindLabel[p.kind] ?? p.kind}</td>
                    <td data-label="Endpoint" className="d-cell">
                      {p.apiBase ? <span className="mono">{p.apiBase}</span> : <span className="faint">provider default</span>}
                      {p.apiVersion ? <span className="faint"> · {p.apiVersion}</span> : null}
                    </td>
                    <td data-label="Key">
                      {p.hasSecret ? <span className="kind h">stored</span> : <span className="kind ru">none</span>}
                    </td>
                    <td data-label="On">
                      <Toggle label={`${p.name} enabled`} checked={p.enabled} onChange={(v) => void toggle(p, v)} />
                    </td>
                    <td data-label="Actions" className="d-cell">
                      <button type="button" className="btn" onClick={() => void remove(p)}>Remove</button>
                      <span className="faint"> · updated <Time iso={p.updatedAt} /></span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form className="stack-form" onSubmit={add} noValidate data-testid="llm-add-provider">
          <h3 className="sh">Add a provider</h3>
          <div className="form-grid">
            <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Anthropic (production)" />
            <div className="fld">
              <label htmlFor="llm-provider-kind">Kind</label>
              <select id="llm-provider-kind" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
                {KINDS.map((k) => <option key={k} value={k}>{kindLabel[k] ?? k}</option>)}
              </select>
            </div>
            <Field label="API key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} hint="Stored once and never shown again. Leave empty for a keyless endpoint." />
            <Field label="Base URL" type="url" value={apiBase} onChange={(e) => setApiBase(e.target.value)} hint="Only for a self-hosted or proxied endpoint." />
            <Field label="API version" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} hint="Azure needs one; most kinds do not." />
          </div>
          <button type="submit" className="btn primary" disabled={busy || name.trim() === ''}>Add provider</button>
        </form>
      </div>
    </section>
  );
}
