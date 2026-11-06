import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { PersonConnectionProvider } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { PlainFrame } from '../../components/frames';
import { QueryView } from '../../components/states';
import { disconnectPersonConnection, fetchPersonProviders, startPersonConnection } from './personApi';
import {
  initialServices,
  message,
  notSetUpSentence,
  problemSentence,
  reconnectSentence,
  reconnectTitle,
  renewedLine,
  resultFromQuery,
  standing,
  withoutResult,
  writesLine,
} from './personWords';
import { BackIcon } from '../../shell/icons';

/*
 * `/settings/connections` (PLAN P8-02): the outside accounts a person signs in to once, for themselves. Google, Microsoft and Notion are listed with where each
 * stands for this person. Connect sends the browser to the provider's own page; the provider sends it back here with `connected=` or `connect_error=` in the
 * address, which the page turns into a sentence. A bot uses a connection only when this person is the one asking, and only for the services ticked here.
 * Tokens are sealed by the server and never shown.
 */
export function PersonConnections() {
  const q = useQuery('person-providers', fetchPersonProviders);
  const loc = useLocation();
  const navigate = useNavigate();
  // the way back from a provider is read once and then taken out of the address, so a reload does not say it again
  const [back] = useState(() => loc.search);
  const [dismissed, setDismissed] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    if (withoutResult(loc.search) !== loc.search) void navigate({ pathname: loc.pathname, search: withoutResult(loc.search) }, { replace: true });
  }, [loc.pathname, loc.search, navigate]);
  // the provider's own name replaces the id once the list is here
  const labels = q.status === 'ok' ? Object.fromEntries(q.data.providers.map((p) => [p.id, p.label])) : {};
  const shown = dismissed ? null : resultFromQuery(back, labels);

  return (
    <PlainFrame title="Connected accounts">
      <p className="cn-back"><Link to="/account/profile"><BackIcon size={12} /> Back to your account</Link></p>
      <p className="lede">
        Sign in to an outside account once, and a bot can use it for you: but only when you are the one asking, and only for the things you tick below. Nobody else
        can use your connection, and manythreads never shows the sign-in it keeps. You can disconnect at any time.
      </p>
      <p className="cn-back" data-testid="person-other-link">
        Looking for mailboxes and other connections of your own? See <Link to="/account/connections">your other connections</Link>.
      </p>
      <div className="cn-status" role="status" aria-live="polite" data-testid="person-status">
        {shown ? <p className={`notice ${shown.tone}`} data-testid="person-result">{shown.text}</p> : null}
        {said ? <p className="notice ok">{said}</p> : null}
      </div>

      <QueryView q={q}>
        {({ providers }) => (
          <ul className="cn-list cp-list" data-testid="person-providers">
            {providers.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                onChanged={(line) => {
                  setDismissed(true);
                  setSaid(line);
                  q.reload();
                }}
              />
            ))}
          </ul>
        )}
      </QueryView>
    </PlainFrame>
  );
}

function ProviderCard({ provider: p, onChanged }: { provider: PersonConnectionProvider; onChanged: (said: string | null) => void }) {
  const look = standing(p);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(initialServices(p)));
  const [busy, setBusy] = useState<null | 'connect' | 'disconnect'>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canStart = p.configured;
  const none = ticked.size === 0;
  const idle = busy === null;

  const connect = async (): Promise<void> => {
    if (!canStart || none) return;
    setBusy('connect');
    setError(null);
    try {
      const { url } = await startPersonConnection(p.id, { services: [...ticked] });
      // the provider's own page; it sends the browser back to this page
      window.location.assign(url);
    } catch (e) {
      setBusy(null);
      setError(message(e));
    }
  };
  const disconnect = async (): Promise<void> => {
    setBusy('disconnect');
    setError(null);
    try {
      await disconnectPersonConnection(p.id);
      setConfirm(false);
      onChanged(`${p.label} was disconnected. Bots can no longer use it for you.`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };
  const toggle = (id: string, on: boolean): void =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const verb = p.connected ? (p.state === 'needs_reconnect' ? 'Reconnect' : 'Update what is allowed') : 'Connect';

  return (
    <li className="cn-row cp-card" data-provider={p.id} data-configured={p.configured} data-connected={p.connected} data-testid="person-provider" aria-busy={busy !== null || undefined}>
      <div className="cn-main">
        <div className="cn-title">
          <strong className="cn-name">{p.label}</strong>
          <span className={`cn-state ${look.tone}`} data-state={look.label} data-testid="person-state"><span aria-hidden="true">{look.glyph}</span> {look.label}</span>
        </div>
        {p.connected && p.accountLabel ? <div className="cn-detail" data-testid="person-account">Signed in as {p.accountLabel}</div> : null}
        {!p.configured ? (
          <p className="cn-detail" data-testid="person-not-configured">
            {notSetUpSentence(p.label)} <Link to="/settings/connections/apps">Admins: set it up here.</Link>
            <br />
            <span className="faint">The address to register at {p.label}: <code className="mono">{p.redirectUri}</code></span>
          </p>
        ) : null}
        {p.connected && p.state === 'needs_reconnect' ? (
          <p className="cn-detail cn-warn" data-testid="person-needs-reconnect">
            <strong>{reconnectTitle(p.label)}</strong>
            <br />
            {reconnectSentence(p.label)}
          </p>
        ) : null}
        {p.connected && p.state === 'ok' && p.problem ? <p className="cn-detail cn-warn" data-testid="person-problem">{problemSentence(p.label, p.problem)}</p> : null}
        {p.connected && p.state === 'ok' && !p.problem && p.refreshedAt ? <p className="cn-detail faint" data-testid="person-renewed">{renewedLine(p.refreshedAt)}</p> : null}

        <fieldset className="cp-services" disabled={!canStart || !idle}>
          <legend className="cp-legend">What a bot may use for you</legend>
          {p.services.map((s) => (
            <label key={s.id} className="check cp-service" data-testid="person-service" data-service={s.id}>
              <input type="checkbox" className="cp-box" checked={ticked.has(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
              <span>
                <b>{s.label}</b>
                {s.granted ? <span className="cp-granted"> · allowed</span> : null}
                <span className="cp-desc">{s.description} <span className="faint">{writesLine(s)}</span></span>
              </span>
            </label>
          ))}
        </fieldset>
        {none && canStart ? <p className="cn-detail faint">Tick at least one thing to connect.</p> : null}
        {error ? <p className="cp-error" role="alert" data-testid="person-error">{error}</p> : null}
      </div>
      <div className="cn-actions">
        <button type="button" className="btn primary" disabled={!canStart || none || !idle} onClick={() => void connect()} aria-label={`${verb} ${p.label}`} data-testid="person-connect">
          {busy === 'connect' ? 'Opening…' : verb}
        </button>
        {p.connected && !confirm ? (
          <button type="button" className="btn" disabled={!idle} onClick={() => setConfirm(true)} aria-label={`Disconnect ${p.label}`} data-testid="person-disconnect">Disconnect</button>
        ) : null}
        {p.connected && confirm ? (
          <span className="cp-confirm" role="group" aria-label={`Disconnect ${p.label}?`}>
            <span>Bots stop using it for you.</span>
            <button type="button" className="btn danger" disabled={!idle} onClick={() => void disconnect()} data-testid="person-disconnect-confirm">{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>
            <button type="button" className="btn" disabled={!idle} onClick={() => setConfirm(false)}>Keep it</button>
          </span>
        ) : null}
      </div>
    </li>
  );
}
