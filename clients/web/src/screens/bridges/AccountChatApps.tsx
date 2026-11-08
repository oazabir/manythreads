import { useEffect, useState } from 'react';
import type { BridgeAvailable, BridgeIdentity, LinkCodeResponse } from '@manythreads/shared';
import { PageHeader } from '../../components/PageHeader';
import { QueryView } from '../../components/states';
import { Alert, Time } from '../../components/ui';
import { useQuery } from '../../app/useQuery';
import '../../styles/bridges.css';
import { createMyLinkCode, fetchMyBridges, unlinkMyBridge } from './api';
import { codeExpired, failureWords, openableLink, PROVIDER_LABEL } from './words';

/** Set to true when the person's chat-apps page is built (PLAN Bundle D, P16-09). */
export const ACCOUNT_CHAT_APPS_READY = true;

/**
 * `/account/chat-apps`: link or unlink your own chat user with a code. The code works once and for ten minutes; it proves the chat user is yours. Only linked people are heard by a bot,
 * and what you write there is posted as you.
 */
export function AccountChatApps() {
  const q = useQuery('account-chat-apps', fetchMyBridges);
  return (
    <>
      <PageHeader title="Chat apps" description="Link your Telegram, WhatsApp, Slack or Teams account so you can talk to a bot from there. What you write there is posted as you." />
      <QueryView q={q}>
        {({ available, identities }) =>
          available.length === 0 ? (
            <section className="block" data-testid="chat-apps-account-none">
              <div className="block-body"><p className="br-note">No chat app is switched on yet. An admin can turn one on under Settings, Chat apps.</p></div>
            </section>
          ) : (
            <div className="br-list" data-testid="chat-apps-account">
              {available.map((a) => (
                <LinkCard key={a.accountId} available={a} identity={identities.find((i) => i.accountId === a.accountId) ?? null} reload={q.reload} />
              ))}
            </div>
          )
        }
      </QueryView>
    </>
  );
}

function LinkCard({ available, identity, reload }: { available: BridgeAvailable; identity: BridgeIdentity | null; reload: () => void }) {
  const label = PROVIDER_LABEL[available.provider];
  const [code, setCode] = useState<LinkCodeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  // while a code is showing, look again every few seconds: the card turns to "Linked" once the code is used in the chat app. It stops when the code runs out (ten minutes), so a page left open does not ask for ever.
  useEffect(() => {
    if (code === null || identity !== null) return undefined;
    setExpired(codeExpired(code.expiresAt));
    const timer = window.setInterval(() => {
      if (codeExpired(code.expiresAt)) {
        setExpired(true);
        window.clearInterval(timer);
        return;
      }
      reload();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [code, identity, reload]);
  useEffect(() => {
    if (identity !== null) setCode(null);
  }, [identity]);

  const getCode = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setCode(await createMyLinkCode(available.provider));
    } catch (e) {
      setError(failureWords(e, 'A code could not be made. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  };
  const unlink = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await unlinkMyBridge(available.provider);
      reload();
    } catch (e) {
      setError(failureWords(e, 'That could not be unlinked. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="block br-card" aria-labelledby={`bra-${available.provider}`} data-testid={`chat-link-${available.provider}`} data-linked={identity !== null}>
      <div className="br-head">
        <h2 className="bh" id={`bra-${available.provider}`}>{label}</h2>
        {identity ? <span className="chip ok" role="status">Linked</span> : <span className="chip">Not linked</span>}
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {identity ? (
        <>
          <p className="br-note">
            Linked as {identity.externalLabel ?? 'your account'} since <Time iso={identity.verifiedAt} />. Write to {available.handle ?? available.displayName} to talk to a bot; send {available.provider === 'slack' || available.provider === 'teams' ? 'bot' : '/bot'} there to choose which one.
          </p>
          <div className="br-actions"><button type="button" className="btn" onClick={() => void unlink()} disabled={busy} data-testid={`chat-link-${available.provider}-unlink`}>Unlink</button></div>
        </>
      ) : code ? (
        <div className="br-code" data-testid={`chat-link-${available.provider}-code`}>
          <p className="br-note">{code.instruction}</p>
          <div className="br-code-digits mono" aria-hidden="true">{code.code}</div>
          <span className="sr-only">Your code is {code.code.split('').join(' ')}</span>
          {expired ? (
            <p className="br-note" role="status" data-testid={`chat-link-${available.provider}-expired`}>This code has run out. Get a new one.</p>
          ) : (
            <p className="br-note">It works once, until <Time iso={code.expiresAt} />. Keep it to yourself.</p>
          )}
          <div className="br-actions">
            {openableLink(code.deepLink) && !expired ? <a className="btn primary" href={openableLink(code.deepLink)!} target="_blank" rel="noreferrer noopener">Open {label}</a> : null}
            <button type="button" className="btn" onClick={() => void getCode()} disabled={busy}>New code</button>
          </div>
        </div>
      ) : (
        <>
          <p className="br-note">Link your {label} so a bot knows it is you. You get a code here and send it to {available.handle ?? available.displayName}.</p>
          <div className="br-actions"><button type="button" className="btn primary" onClick={() => void getCode()} disabled={busy} data-testid={`chat-link-${available.provider}-get`}>{busy ? 'Making a code…' : 'Get a code'}</button></div>
        </>
      )}
    </section>
  );
}
