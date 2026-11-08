import { useState } from 'react';
import type { BridgeAccount, BridgeProvider, PutBridgeCredentialsRequest } from '@manythreads/shared';
import { PageHeader } from '../../components/PageHeader';
import { Dialog } from '../../components/Dialog';
import { QueryView } from '../../components/states';
import { Alert, Field, Time, Toggle } from '../../components/ui';
import { useQuery } from '../../app/useQuery';
import '../../styles/bridges.css';
import { deleteBridgeAccount, fetchBridgeAccounts, saveBridgeAccount, saveBridgeCredentials, switchBridge } from './api';
import { BUILT_PROVIDERS, callbackUrl, failureWords, LATER_PROVIDERS, PROVIDER_LABEL, STATUS_WORDS, whatItDoes } from './words';

/** Set to true when the admin page for chat apps is built (PLAN Bundle D, P16-09). */
export const ADMIN_CHAT_APPS_READY = true;

/**
 * `/settings/workspace/chat-apps`: per service a switch, the credentials and the health. Credentials go in once and are sealed: no page ever shows them again, only which are set.
 * Telegram needs the bot token from BotFather. WhatsApp needs the phone number id, the access token, the app secret and a verify word of the admin's choosing.
 */
export function AdminChatApps() {
  const q = useQuery('admin-chat-apps', fetchBridgeAccounts);
  return (
    <>
      <PageHeader title="Chat apps" description="Let people reach a bot from their phone, and join a public channel to an outside chat. Only people who linked their own account are ever heard." />
      <QueryView q={q}>
        {({ accounts }) => (
          <div className="br-list" data-testid="chat-apps-admin">
            {BUILT_PROVIDERS.map((p) => (
              <ProviderCard key={p} provider={p} account={accounts.find((a) => a.provider === p) ?? null} onChanged={q.reload} />
            ))}
            {LATER_PROVIDERS.map((p) => (
              <section key={p} className="block br-card later" aria-labelledby={`br-${p}`} data-testid={`chat-app-${p}`} data-state="later">
                <div className="br-head">
                  <h2 className="bh" id={`br-${p}`}>{PROVIDER_LABEL[p]}</h2>
                  <span className="chip">Coming later</span>
                </div>
                <p className="br-note">{whatItDoes(p)}</p>
              </section>
            ))}
          </div>
        )}
      </QueryView>
    </>
  );
}

function ProviderCard({ provider, account, onChanged }: { provider: BridgeProvider; account: BridgeAccount | null; onChanged: () => void }) {
  const label = PROVIDER_LABEL[provider];
  const [current, setCurrent] = useState<BridgeAccount | null>(account);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // a reload from the parent brings a fresher account
  if (account !== null && current !== null && account !== current && account.id === current.id && JSON.stringify(account) !== JSON.stringify(current) && !busy) setCurrent(account);

  const run = async (work: () => Promise<{ account: BridgeAccount } | void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await work();
      if (res) setCurrent(res.account);
    } catch (e) {
      setError(failureWords(e, 'That could not be saved. Nothing changed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="block br-card" aria-labelledby={`br-${provider}`} data-testid={`chat-app-${provider}`} data-state={current?.status ?? 'none'}>
      <div className="br-head">
        <h2 className="bh" id={`br-${provider}`}>{label}</h2>
        {current ? <span className={`chip ${current.status === 'on' ? 'ok' : current.status === 'attention' ? 'warn' : ''}`} role="status" data-testid={`chat-app-${provider}-status`}>{STATUS_WORDS[current.status]}</span> : <span className="chip">Not set up</span>}
      </div>
      <p className="br-note">{whatItDoes(provider)}</p>
      {error ? <Alert>{error}</Alert> : null}
      {current === null ? (
        <SetUp provider={provider} busy={busy} onCreate={(displayName, externalAppId) => run(() => saveBridgeAccount(provider, { displayName, ...(externalAppId ? { externalAppId } : {}) }))} />
      ) : (
        <>
          {current.lastError ? <div className="br-problem" role="alert" data-testid={`chat-app-${provider}-error`}>{current.lastError}</div> : null}
          <Credentials provider={provider} account={current} busy={busy} onSave={(creds) => run(() => saveBridgeCredentials(provider, creds))} onId={(id) => run(() => saveBridgeAccount(provider, { displayName: current.displayName, externalAppId: id }))} />
          {provider === 'whatsapp' ? (
            <div className="br-callback">
              <span className="br-label">Address to give Meta</span>
              <code className="mono" data-testid="chat-app-callback">{callbackUrl(current.callbackPath)}</code>
              <span className="br-note">Paste it as the webhook address in the Meta console, with the verify word you chose above, and subscribe to messages.</span>
            </div>
          ) : null}
          <div className="br-switch">
            <Toggle checked={current.status === 'on'} busy={busy} label={`${label} is ${current.status === 'on' ? 'on' : 'off'}`} onChange={(on) => void run(() => switchBridge(provider, on))} />
            <span>{current.status === 'on' ? `On${current.handle ? ` as ${current.handle}` : ''}` : 'Turn it on when the credentials are in'}</span>
          </div>
          <dl className="br-facts" data-testid={`chat-app-${provider}-health`}>
            <div><dt>Linked people</dt><dd>{current.linkedPeople}</dd></div>
            <div><dt>Joined channels</dt><dd>{current.linkedChannels}</dd></div>
            <div><dt>Messages in / out</dt><dd>{current.inboundCount} / {current.outboundCount}</dd></div>
            <div><dt>From people not linked</dt><dd>{current.droppedCount}</dd></div>
            <div><dt>Last message</dt><dd>{current.lastInboundAt ?? current.lastOutboundAt ? <Time iso={(current.lastInboundAt ?? current.lastOutboundAt)!} /> : 'None yet'}</dd></div>
          </dl>
          <div className="br-actions">
            <button type="button" className="btn quiet" onClick={() => setConfirmRemove(true)} disabled={busy} data-testid={`chat-app-${provider}-remove`}>Remove {label}</button>
          </div>
          {confirmRemove ? (
            <Dialog
              title={`Remove ${label}?`}
              onClose={() => setConfirmRemove(false)}
              footer={
                <>
                  <button type="button" className="btn" onClick={() => setConfirmRemove(false)}>Keep it</button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => {
                      setConfirmRemove(false);
                      void run(async () => {
                        await deleteBridgeAccount(provider);
                        setCurrent(null);
                        onChanged();
                      });
                    }}
                    data-testid={`chat-app-${provider}-remove-yes`}
                  >
                    Remove
                  </button>
                </>
              }
            >
              <p className="dlg-text">People will no longer be able to reach a bot through {label}, and channels joined to a {label} chat are unjoined. The saved credentials are deleted.</p>
            </Dialog>
          ) : null}
        </>
      )}
    </section>
  );
}

function SetUp({ provider, busy, onCreate }: { provider: BridgeProvider; busy: boolean; onCreate: (displayName: string, externalAppId: string) => Promise<void> }) {
  const [name, setName] = useState(PROVIDER_LABEL[provider]);
  const [id, setId] = useState('');
  return (
    <form
      className="br-form"
      onSubmit={(e) => {
        e.preventDefault();
        void onCreate(name.trim(), id.trim());
      }}
    >
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required hint="How it is shown to people who link their account." />
      {provider === 'whatsapp' ? <Field label="Phone number id" className="mono" value={id} onChange={(e) => setId(e.target.value)} inputMode="numeric" hint="From the WhatsApp section of your Meta app. It is a long number, not the phone number itself." /> : null}
      <button type="submit" className="btn primary" disabled={busy || name.trim() === ''}>Set up {PROVIDER_LABEL[provider]}</button>
    </form>
  );
}

function Credentials({ provider, account, busy, onSave, onId }: { provider: BridgeProvider; account: BridgeAccount; busy: boolean; onSave: (c: PutBridgeCredentialsRequest) => Promise<void>; onId: (id: string) => Promise<void> }) {
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [word, setWord] = useState('');
  const [id, setId] = useState('');
  const set = (name: 'bot_token' | 'app_secret' | 'inbound_secret'): boolean => account.secretsSet.includes(name);
  const saved = (ok: boolean): string => (ok ? 'Saved. Paste a new one to replace it.' : 'Not saved yet.');
  const whatsapp = provider === 'whatsapp';
  const dirty = token !== '' || secret !== '' || word !== '';
  return (
    <form
      className="br-form"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const creds: PutBridgeCredentialsRequest = {
          ...(token ? { botToken: token } : {}),
          ...(whatsapp && secret ? { appSecret: secret } : {}),
          ...(whatsapp && word ? { inboundSecret: word } : {}),
        };
        void onSave(creds).then(() => {
          setToken('');
          setSecret('');
          setWord('');
        });
      }}
    >
      {whatsapp ? (
        <Field label="Phone number id" className="mono" value={id} placeholder={account.handle ? `Set (${account.handle})` : 'Not saved yet'} onChange={(e) => setId(e.target.value)} inputMode="numeric" hint={<><span>Save it before the access token.</span> <button type="button" className="btn s" disabled={busy || id.trim() === ''} onClick={() => void onId(id.trim()).then(() => setId(''))}>Save the number id</button></>} />
      ) : null}
      <Field label={whatsapp ? 'Access token' : 'Bot token'} type="password" autoComplete="new-password" className="mono" value={token} onChange={(e) => setToken(e.target.value)} hint={`${saved(set('bot_token'))}${provider === 'telegram' ? ' From BotFather, it looks like 123456789:ABC…' : ''}`} data-testid={`chat-app-${provider}-token`} />
      {whatsapp ? <Field label="App secret" type="password" autoComplete="new-password" className="mono" value={secret} onChange={(e) => setSecret(e.target.value)} hint={saved(set('app_secret'))} /> : null}
      {whatsapp ? <Field label="Verify word" type="password" autoComplete="new-password" className="mono" value={word} onChange={(e) => setWord(e.target.value)} hint={`${saved(set('inbound_secret'))} Any word you choose; you type the same one in the Meta console.`} /> : null}
      <p className="br-note">Saving new credentials turns the app off until you turn it on again.</p>
      <button type="submit" className="btn primary" disabled={busy || !dirty} data-testid={`chat-app-${provider}-save`}>{busy ? 'Saving…' : 'Save credentials'}</button>
    </form>
  );
}
