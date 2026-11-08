import { useState, type FormEvent } from 'react';
import type { ProviderEndpoint, WebhookProvider } from '@manythreads/shared';
import { useQuery } from '../app/useQuery';
import { SkeletonRows } from '../components/Skeleton';
import { CopyBox } from './CopyBox';
import { messageOf } from './model';
import { createProviderHook, deleteProviderHook, fetchProviderHooks, putProviderSigningSecret, rotateProviderHook, updateProviderHook } from './providerApi';
import { PASTED_PROVIDERS, PROVIDER_HINTS, PROVIDER_LABELS, PROVIDER_ORDER, addressOf, parseKinds, proposedSlug, receivedLine } from './providerModel';

/** Set to true by work package H when the "Work apps" tab of the Integrations dialog is built (PLAN Bundle D, P16-10). Until then the tab is not drawn. */
export const PROVIDER_HOOKS_TAB_READY = true;

/*
 * The addresses a work app (GitHub, GitLab, Jira, Linear, Zendesk, Intercom, HubSpot, Asana, or any sender) calls for this channel (PLAN Bundle D, P16-10). The address carries no secret:
 * the app proves itself with a signature made from a signing secret that only the app and this server know. A bot starts from an event when its trigger names the address by its short name.
 */

interface Reveal {
  title: string;
  address: string;
  secret: string | null;
  provider: WebhookProvider;
}
type Note = { ok: boolean; text: string };

function EndpointRow({ endpoint, onChange, onShow, onNote }: { endpoint: ProviderEndpoint; onChange: () => void; onShow: (r: Reveal) => void; onNote: (n: Note) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [name, setName] = useState(endpoint.name);
  const [kinds, setKinds] = useState(endpoint.eventFilter.join(', '));
  const [secret, setSecret] = useState('');
  const pasted = endpoint.secretSource === 'pasted';
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      onNote({ ok: false, text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };
  const address = addressOf(endpoint);
  return (
    <li className="wh-row wh-app-row" data-testid="provider-row" data-endpoint-id={endpoint.id}>
      <div className="wh-row-main">
        <span className="wh-name">{endpoint.name}</span>
        <span className="chip">{PROVIDER_LABELS[endpoint.provider].replace(/ \(.*\)$/, '')}</span>
      </div>
      <p className="wh-use">
        Bots listen for it by the short name <span className="wh-mono" data-testid="provider-slug">{endpoint.slug}</span>. {endpoint.eventFilter.length > 0 ? `Only these events: ${endpoint.eventFilter.join(', ')}.` : 'Every event the app sends.'}
      </p>
      <p className="wh-addr" data-testid="provider-state">{receivedLine(endpoint)}</p>
      <div className="wh-app-address">
        <CopyBox value={address} label={`Address for ${endpoint.name}`} testId="provider-address" />
      </div>

      {editing ? (
        <form
          className="wh-form wh-app-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await updateProviderHook(endpoint.id, { name: name.trim(), eventFilter: parseKinds(kinds) });
              setEditing(false);
              onNote({ ok: true, text: `"${name.trim()}" was changed.` });
              onChange();
            });
          }}
        >
          <div className="wh-field wh-field-name">
            <label className="dlg-label" htmlFor={`wh-app-name-${endpoint.id}`}>Name</label>
            <input id={`wh-app-name-${endpoint.id}`} className="dlg-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <div className="wh-field wh-field-wide">
            <label className="dlg-label" htmlFor={`wh-app-kinds-${endpoint.id}`}>Only these events (leave empty for all)</label>
            <input id={`wh-app-kinds-${endpoint.id}`} className="dlg-input" value={kinds} onChange={(e) => setKinds(e.target.value)} placeholder="ticket.created, issue.*" autoComplete="off" data-testid="provider-edit-kinds" />
          </div>
          <button type="submit" className="btn primary" disabled={busy || name.trim() === ''} data-testid="provider-edit-save">Save</button>
          <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : null}

      {pasting ? (
        <form
          className="wh-form wh-app-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await putProviderSigningSecret(endpoint.id, secret);
              setSecret('');
              setPasting(false);
              onNote({ ok: true, text: `The signing secret of "${endpoint.name}" was saved. It is never shown again.` });
              onChange();
            });
          }}
        >
          <div className="wh-field wh-field-wide">
            <label className="dlg-label" htmlFor={`wh-app-secret-${endpoint.id}`}>Signing secret from {PROVIDER_LABELS[endpoint.provider].replace(/ \(.*\)$/, '')}</label>
            <input id={`wh-app-secret-${endpoint.id}`} className="dlg-input" type="password" value={secret} minLength={8} maxLength={500} onChange={(e) => setSecret(e.target.value)} autoComplete="off" data-testid="provider-paste-input" />
          </div>
          <button type="submit" className="btn primary" disabled={busy || secret.length < 8} data-testid="provider-paste-save">Save secret</button>
          <button type="button" className="btn" onClick={() => setPasting(false)}>Cancel</button>
        </form>
      ) : null}

      <div className="wh-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => setEditing((v) => !v)} data-testid="provider-edit">Change</button>
        {pasted ? (
          <button type="button" className="btn" disabled={busy} onClick={() => setPasting((v) => !v)} data-testid="provider-paste">{endpoint.hasSecret ? 'Paste a new secret' : 'Paste the secret'}</button>
        ) : endpoint.provider === 'asana' ? null : (
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-testid="provider-rotate"
            title="Makes a new signing secret. The old one stops working at once, so put the new one into the app."
            onClick={() =>
              void run(async () => {
                const made = await rotateProviderHook(endpoint.id);
                onShow({ title: `New signing secret for "${endpoint.name}"`, address, secret: made.signingSecret, provider: endpoint.provider });
                onChange();
              })
            }
          >
            New signing secret
          </button>
        )}
        {confirming ? (
          <span className="wh-confirm" role="group" aria-label={`Switch off ${endpoint.name}`}>
            <span>Switch it off for good?</span>
            <button
              type="button"
              className="btn wh-danger"
              disabled={busy}
              data-testid="provider-revoke-confirm"
              onClick={() =>
                void run(async () => {
                  await deleteProviderHook(endpoint.id);
                  onNote({ ok: true, text: `"${endpoint.name}" was switched off. The app's calls to it are refused.` });
                  setConfirming(false);
                  onChange();
                })
              }
            >
              Yes, switch off
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>Keep it</button>
          </span>
        ) : (
          <button type="button" className="btn quiet wh-danger-text" disabled={busy} data-testid="provider-revoke" onClick={() => setConfirming(true)}>Switch off</button>
        )}
      </div>
    </li>
  );
}

export function ProviderHooksTab({ channelId }: { channelId: string }) {
  const list = useQuery(`provider-hooks:${channelId}`, () => fetchProviderHooks(channelId));
  const [provider, setProvider] = useState<WebhookProvider>('github');
  const [slug, setSlug] = useState(proposedSlug('github'));
  const [slugTouched, setSlugTouched] = useState(false);
  const [name, setName] = useState('');
  const [kinds, setKinds] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Reveal | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  const pickProvider = (next: WebhookProvider): void => {
    setProvider(next);
    if (!slugTouched) setSlug(proposedSlug(next));
    setSecret('');
  };
  const pastes = PASTED_PROVIDERS.has(provider);
  const create = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    if (slug.trim() === '') return;
    setBusy(true);
    setNote(null);
    try {
      const made = await createProviderHook(channelId, {
        provider,
        slug: slug.trim().toLowerCase(),
        ...(name.trim() !== '' ? { name: name.trim() } : {}),
        eventFilter: parseKinds(kinds),
        ...(pastes && secret !== '' ? { signingSecret: secret } : {}),
      });
      setShown({ title: `Address for "${made.endpoint.name}"`, address: addressOf(made.endpoint), secret: made.signingSecret, provider });
      setName('');
      setKinds('');
      setSecret('');
      setSlugTouched(false);
      setSlug(proposedSlug(provider));
      list.reload();
    } catch (err) {
      setNote({ ok: false, text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const endpoints = list.status === 'ok' ? list.data.endpoints : [];
  return (
    <>
      <p className="wh-lead">
        A work app such as GitHub, Zendesk or Jira can tell this channel when something happens. Make an address here, give it to the app, and a bot whose trigger names the address by its short name starts when an event
        arrives. The address itself is not a secret. The app proves each call with a <strong>signing secret</strong>: a long password that only the app and this server know, used to sign every call, so a call that is
        not signed with it is refused. You put it into the app once; it is shown once and never again.
      </p>

      {shown ? (
        <div className="wh-reveal" role="status" data-testid="provider-reveal">
          <p className="wh-reveal-title">
            {shown.title}.{shown.secret !== null ? ' Copy the signing secret now: it is shown only once.' : ''}
          </p>
          <p className="wh-hint">Address to give the app</p>
          <CopyBox value={shown.address} label="Address" testId="provider-reveal-address" />
          {shown.secret !== null ? (
            <>
              <p className="wh-hint">Signing secret</p>
              <CopyBox value={shown.secret} label="Signing secret" testId="provider-reveal-secret" />
            </>
          ) : null}
          <p className="wh-hint">{PROVIDER_HINTS[shown.provider]}</p>
          <button type="button" className="btn" onClick={() => setShown(null)}>I have copied it</button>
        </div>
      ) : null}

      {note ? <p className={note.ok ? 'wh-note' : 'dlg-error'} role={note.ok ? 'status' : 'alert'} data-testid="provider-note">{note.text}</p> : null}

      <h3 className="wh-h">Addresses for this channel</h3>
      {list.status === 'loading' ? <SkeletonRows rows={2} label="Loading" /> : null}
      {list.status === 'error' ? <p className="dlg-error" role="alert">{list.error.message}</p> : null}
      {list.status === 'ok' && endpoints.length === 0 ? <p className="wh-hint" data-testid="providers-empty">None yet. Make one below.</p> : null}
      {endpoints.length > 0 ? (
        <ul className="wh-list">
          {endpoints.map((p) => (
            <EndpointRow key={p.id} endpoint={p} onChange={list.reload} onShow={setShown} onNote={setNote} />
          ))}
        </ul>
      ) : null}

      <h3 className="wh-h">Make an address</h3>
      <form className="wh-form" onSubmit={(e) => void create(e)}>
        <div className="wh-field">
          <label className="dlg-label" htmlFor="wh-app-provider">App</label>
          <select id="wh-app-provider" className="dlg-input" value={provider} onChange={(e) => pickProvider(e.target.value as WebhookProvider)} data-testid="provider-kind">
            {PROVIDER_ORDER.map((p) => (
              <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
            ))}
          </select>
        </div>
        <div className="wh-field wh-field-name">
          <label className="dlg-label" htmlFor="wh-app-slug">Short name</label>
          <input
            id="wh-app-slug"
            className="dlg-input"
            value={slug}
            maxLength={63}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            autoComplete="off"
            data-testid="provider-slug-input"
          />
        </div>
        <div className="wh-field wh-field-name">
          <label className="dlg-label" htmlFor="wh-app-name">Name (optional)</label>
          <input id="wh-app-name" className="dlg-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={PROVIDER_LABELS[provider].replace(/ \(.*\)$/, '')} autoComplete="off" data-testid="provider-name" />
        </div>
        <div className="wh-field wh-field-wide">
          <label className="dlg-label" htmlFor="wh-app-kinds">Only these events (optional)</label>
          <input id="wh-app-kinds" className="dlg-input" value={kinds} onChange={(e) => setKinds(e.target.value)} placeholder="ticket.created, issue.*" autoComplete="off" data-testid="provider-kinds" />
        </div>
        {pastes ? (
          <div className="wh-field wh-field-wide">
            <label className="dlg-label" htmlFor="wh-app-secret">Signing secret from {PROVIDER_LABELS[provider]} (you can add it later)</label>
            <input id="wh-app-secret" className="dlg-input" type="password" value={secret} minLength={8} maxLength={500} onChange={(e) => setSecret(e.target.value)} autoComplete="off" data-testid="provider-secret" />
          </div>
        ) : null}
        <button type="submit" className="btn primary" disabled={busy || slug.trim() === '' || (secret !== '' && secret.length < 8)} data-testid="provider-create">Make address</button>
      </form>
      <p className="wh-hint">
        The short name is what a bot&rsquo;s trigger uses: <span className="wh-mono">type: webhook</span> and <span className="wh-mono">connection: {slug.trim() === '' ? 'github' : slug.trim()}</span>. Events are named like
        <span className="wh-mono"> ticket.created</span>; <span className="wh-mono">ticket.*</span> means all of them. At most 20 integrations per channel, and 120 calls a minute for each address.
      </p>
      <p className="wh-hint">{PROVIDER_HINTS[provider]}</p>
    </>
  );
}
