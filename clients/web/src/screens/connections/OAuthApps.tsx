import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { OAuthAppStatus } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { PlainFrame } from '../../components/frames';
import { QueryView } from '../../components/states';
import { Field } from '../../components/ui';
import { clearOAuthApp, fetchOAuthApps, putOAuthApp } from './personApi';
import { message } from './personWords';
import { appSourceLine, checkApp } from './appWords';

/*
 * `/settings/connections/apps` (PLAN P16-02), for workspace admins: the app this workspace signs its people in to Google, Microsoft and Notion with. The admin makes an
 * app at the provider, registers the address shown here, and enters the app's client id and secret. The secret is sent once, kept sealed by the server, and never
 * shown again: this page only says whether one is stored. The field is emptied after every attempt.
 */
export function OAuthApps() {
  const q = useQuery('oauth-apps', fetchOAuthApps);
  return (
    <PlainFrame title="Sign-in apps">
      <p className="cn-back"><Link to="/settings/connections">← Back to connected accounts</Link></p>
      <p className="lede">
        People connect their own Google, Microsoft and Notion accounts with an app that belongs to your company, not to us. Make the app at the provider, register the
        address shown under it, then enter its client id and client secret here. The secret is kept sealed and cannot be shown again.
      </p>
      <QueryView q={q}>
        {({ apps }) => (
          <ul className="cn-list cp-list" data-testid="oauth-apps">
            {apps.map((a) => (
              <AppCard key={a.provider} app={a} onChanged={() => q.reload()} />
            ))}
          </ul>
        )}
      </QueryView>
    </PlainFrame>
  );
}

function AppCard({ app: a, onChanged }: { app: OAuthAppStatus; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [tenant, setTenant] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a ref, not the state: two quick presses can both pass before the first re-render sets `busy`
  const sending = useRef(false);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (sending.current) return;
    const problem = checkApp({ clientId, clientSecret, tenant });
    if (problem) {
      setError(problem);
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await putOAuthApp(a.provider, { clientId: clientId.trim(), clientSecret, ...(tenant.trim() === '' ? {} : { tenant: tenant.trim() }) });
      setSaid(`The ${a.label} app was saved. People can connect ${a.label} now.`);
      setOpen(false);
      setClientId('');
      setTenant('');
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      // never kept on the page, whatever happened
      setClientSecret('');
      sending.current = false;
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await clearOAuthApp(a.provider);
      setSaid(`The ${a.label} app was removed.`);
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="cn-row cp-card" data-provider={a.provider} data-source={a.source ?? 'none'} data-testid="oauth-app">
      <div className="cn-main">
        <div className="cn-title">
          <strong className="cn-name">{a.label}</strong>
          <span className={`cn-state ${a.source ? 'ok' : 'idle'}`} data-testid="oauth-app-state">
            <span aria-hidden="true">{a.source ? '✓' : '–'}</span> {appSourceLine(a)}
          </span>
        </div>
        {a.source === 'workspace' && a.clientId ? <div className="cn-detail" data-testid="oauth-app-client">Client id <code className="mono">{a.clientId}</code> · the secret is stored and cannot be shown</div> : null}
        <p className="cn-detail faint">
          Register this address at {a.label}: <code className="mono">{a.redirectUri}</code>
        </p>
        {said ? <p className="notice ok" role="status">{said}</p> : null}
        {open ? (
          <form className="cn-form" onSubmit={(e) => void save(e)} noValidate autoComplete="off" data-testid="oauth-app-form">
            <Field label="Client id" value={clientId} maxLength={500} data-autofocus="" onChange={(e) => setClientId(e.target.value)} />
            <Field
              label="Client secret"
              type="password"
              autoComplete="new-password"
              value={clientSecret}
              maxLength={2000}
              hint={a.source === 'workspace' ? 'Enter the secret again. It replaces the stored one.' : 'Copied from the provider. It is stored sealed and cannot be shown again.'}
              data-testid="oauth-app-secret"
              onChange={(e) => setClientSecret(e.target.value)}
            />
            {a.supportsTenant ? (
              <Field label="Directory (optional)" value={tenant} maxLength={64} placeholder="common" hint="Which directory people sign in to: your directory id or domain, or leave empty for the server’s default." onChange={(e) => setTenant(e.target.value)} />
            ) : null}
            {error ? <p className="cp-error" role="alert" data-testid="oauth-app-error">{error}</p> : null}
            <div className="cn-actions">
              <button type="submit" className="btn primary" disabled={busy} data-testid="oauth-app-save">{busy ? 'Saving…' : 'Save'}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => { setOpen(false); setClientSecret(''); setError(null); }}>Cancel</button>
            </div>
          </form>
        ) : null}
        {!open && error ? <p className="cp-error" role="alert">{error}</p> : null}
      </div>
      {!open ? (
        <div className="cn-actions">
          <button type="button" className="btn primary" disabled={busy} aria-label={`${a.source === 'workspace' ? 'Replace' : 'Enter'} the ${a.label} app`} data-testid="oauth-app-edit" onClick={() => { setSaid(null); setOpen(true); }}>
            {a.source === 'workspace' ? 'Replace' : 'Enter the app'}
          </button>
          {a.source === 'workspace' ? (
            <button type="button" className="btn" disabled={busy} aria-label={`Remove the ${a.label} app`} data-testid="oauth-app-remove" onClick={() => void clear()}>Remove</button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
