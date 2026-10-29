import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { isApiError } from '../api/client';
import { fetchChannel, fetchMessage } from '../api/endpoints';
import { useShell } from '../shell/context';
import { useOpenMessage } from '../shell/messageLink';
import { registerWorker } from './push';
import { safeOpenPath } from './settingsModel';

/** How opening a link to a message ended. `denied` is a message the person may not read (or a channel they cannot see): the page says so and shows no text. */
export type OpenOutcome = 'opened' | 'invalid' | 'denied' | 'gone' | 'failed';

/** What a refusal from the server means for a link: 403 is no access, 404 is a message that is no longer there, anything else is a failure to try again. */
export function outcomeOfError(err: unknown): OpenOutcome {
  if (isApiError(err) && err.status === 403) return 'denied';
  if (isApiError(err) && err.status === 404) return 'gone';
  return 'failed';
}

/**
 * Where a link to a message leads (a push notification, a copied link): `/open?channel=<id>&message=<id>[&root=<id>]`. The link carries only ids, so
 * the page asks the server for the message first, which checks that the person may still read it, and then opens it the way the inbox does. With
 * `stay` the caller shows the outcome itself; without it a failure sends the person home.
 */
export function useOpenFromParams(): (params: URLSearchParams, options?: { stay?: boolean }) => Promise<OpenOutcome> {
  const openMessage = useOpenMessage();
  const navigate = useNavigate();
  return async (params, options = {}) => {
    const channelId = params.get('channel');
    const messageId = params.get('message');
    const fail = (outcome: OpenOutcome): OpenOutcome => {
      if (!options.stay) navigate('/', { replace: true });
      return outcome;
    };
    if (!channelId || !messageId) return fail('invalid');
    try {
      await fetchMessage(channelId, messageId);
      const { channel } = await fetchChannel(channelId);
      await openMessage({ channelId, channelKind: channel.kind, channelName: channel.kind === 'channel' ? channel.name : null, teamId: channel.teamId ?? null, messageId, threadRootId: params.get('root') });
      return 'opened';
    } catch (err) {
      return fail(outcomeOfError(err));
    }
  };
}

const OUTCOME_COPY: Record<Exclude<OpenOutcome, 'opened'>, { title: string; body: string }> = {
  denied: { title: 'You cannot see this message.', body: 'It may be in a private channel or a conversation you are not part of. Ask the person who sent you the link to add you.' },
  gone: { title: 'This message is no longer there.', body: 'It may have been deleted, or the link may be wrong.' },
  invalid: { title: 'This link is not complete.', body: 'Ask for the link again.' },
  failed: { title: 'The message could not be opened.', body: 'Check your connection and open the link again.' },
};

/** The `/open` page: it sends the person on to the message, or says plainly why it cannot (and shows nothing of the message). */
export function OpenRoute() {
  const [params] = useSearchParams();
  const open = useOpenFromParams();
  // on a cold page load the team list arrives after the first render: a link that opened before it would name no team (and land on a page the person is not allowed to see)
  const { teamsLoading } = useShell();
  const [outcome, setOutcome] = useState<OpenOutcome | null>(null);
  const key = params.toString();
  useEffect(() => {
    if (teamsLoading) return;
    setOutcome(null);
    let live = true;
    void open(new URLSearchParams(key), { stay: true }).then((o) => live && o !== 'opened' && setOutcome(o));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per link, once the teams are known
  }, [key, teamsLoading]);
  if (outcome === null || outcome === 'opened') return <div className="view-empty" role="status" aria-busy="true"><p className="view-empty-body">Opening the message…</p></div>;
  const copy = OUTCOME_COPY[outcome];
  return (
    <div className="view-empty" role="alert" data-testid={outcome === 'denied' ? 'no-access' : 'open-failed'} data-outcome={outcome}>
      <p className="view-empty-title">{copy.title}</p>
      <p className="view-empty-body">{copy.body}</p>
    </div>
  );
}

/** Registers the service worker once the person is in the app, and follows a click on a push notification while a tab is already open. */
export function PushBridge() {
  const open = useOpenFromParams();
  // the listener below is made once; it calls the newest `open`, which sees the teams as they are now
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    void registerWorker();
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (!data || data.type !== 'manythreads.open' || typeof data.url !== 'string') return;
      const path = safeOpenPath(data.url, window.location.origin);
      void openRef.current(new URL(path, window.location.origin).searchParams);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);
  return null;
}
