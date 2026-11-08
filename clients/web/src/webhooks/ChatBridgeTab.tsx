import { useState } from 'react';
import type { BridgeLink, BridgeProvider, ChannelLinkCodeResponse } from '@manythreads/shared';
import { QueryView } from '../components/states';
import { Alert } from '../components/ui';
import { useQuery } from '../app/useQuery';
import { createChannelLinkCode, deleteBridgeLink, fetchChannelBridges } from '../screens/bridges/api';
import { chatPlace, failureWords, PROVIDER_LABEL } from '../screens/bridges/words';
import '../styles/bridges.css';

/** Set to true when the "Chat apps" tab of the Integrations dialog is built (PLAN Bundle D, P16-09). */
export const CHAT_BRIDGE_TAB_READY = true;

/**
 * Join this public channel to a chat (a Telegram group). The lead gets a code here and sends `/connect <code>` in the group, after adding the bot to it. From then on, what people who linked
 * their account write in the group is posted here as them, and what is written here is sent to the group. A private channel cannot be joined.
 */
export function ChatBridgeTab({ channelId, channelName }: { channelId: string; channelName: string }) {
  const q = useQuery(`channel-bridges-${channelId}`, () => fetchChannelBridges(channelId));
  return (
    <div className="br-tab" data-testid="chat-bridge-tab">
      <QueryView q={q}>
        {({ links, accounts, canLink }) => (
          <>
            <p className="br-note">Join #{channelName} to a chat outside manythreads. Only people who linked their own account are heard there, and what you write here is sent to the chat.</p>
            {links.length > 0 ? (
              <ul className="br-links" data-testid="chat-bridge-links">
                {links.map((l) => (
                  <LinkRow key={l.id} link={l} canUnlink={canLink} reload={q.reload} />
                ))}
              </ul>
            ) : null}
            {!canLink ? (
              <p className="br-note" data-testid="chat-bridge-cannot">Only a team lead or an admin can join a public channel to a chat. A private channel cannot be joined.</p>
            ) : accounts.length === 0 ? (
              <p className="br-note" data-testid="chat-bridge-none">No chat app that can join a channel is switched on. An admin can turn one on under Settings, Chat apps.</p>
            ) : (
              accounts.map((a) => <NewLink key={a.accountId} channelId={channelId} provider={a.provider} handle={a.handle ?? a.displayName} />)
            )}
          </>
        )}
      </QueryView>
    </div>
  );
}

function LinkRow({ link, canUnlink, reload }: { link: BridgeLink; canUnlink: boolean; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await deleteBridgeLink(link.id);
      reload();
    } catch (e) {
      setError(failureWords(e, 'That could not be unjoined. Try again.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="br-link" data-testid="chat-bridge-link" data-provider={link.provider}>
      <span className="br-link-main">
        <b>{PROVIDER_LABEL[link.provider]}</b> {link.externalLabel ? <span>{link.externalLabel}</span> : null}
      </span>
      {canUnlink ? <button type="button" className="btn s" disabled={busy} onClick={() => void remove()} aria-label={`Unjoin ${PROVIDER_LABEL[link.provider]}${link.externalLabel ? ` ${link.externalLabel}` : ''}`}>Unjoin</button> : null}
      {error ? <Alert>{error}</Alert> : null}
    </li>
  );
}

function NewLink({ channelId, provider, handle }: { channelId: string; provider: BridgeProvider; handle: string }) {
  const [code, setCode] = useState<ChannelLinkCodeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = PROVIDER_LABEL[provider];
  const make = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setCode(await createChannelLinkCode(channelId, provider));
    } catch (e) {
      setError(failureWords(e, 'A code could not be made. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="br-newlink" data-testid={`chat-bridge-new-${provider}`}>
      {error ? <Alert>{error}</Alert> : null}
      {code ? (
        <div className="br-code">
          <p className="br-note">Add {handle} to the {label} {chatPlace(provider)}, then send this there:</p>
          <div className="br-code-digits mono" data-testid="chat-bridge-command">{code.command}</div>
          <p className="br-note">It works once, for ten minutes.</p>
        </div>
      ) : (
        <button type="button" className="btn primary" onClick={() => void make()} disabled={busy} data-testid={`chat-bridge-link-${provider}`}>{busy ? 'Making a code…' : `Join a ${label} ${chatPlace(provider)}`}</button>
      )}
    </div>
  );
}
