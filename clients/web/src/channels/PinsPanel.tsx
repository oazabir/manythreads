import { useEffect, useState } from 'react';
import type { ChannelMessage } from '@manythreads/shared';
import { fetchChannel, fetchPins } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { Avatar } from '../components/ui';
import type { PanelEntry } from '../kernel/panel';
import { usePanelTitle } from '../kernel/panel/sub';
import { useOpenMessage } from '../shell/messageLink';
import { PinMessageIcon, UnpinMessageIcon } from '../shell/icons';
import { fullStamp } from './format';
import { usePeople, type People } from './hooks';
import { channelStore } from './store';
import { pinExcerpt, pinsListChanged } from './pinsModel';

/** Who wrote a pinned message, as the reader may see the name. */
const authorName = (m: ChannelMessage, people: People): string => people.byActor(m.authorId)?.name ?? m.author?.displayName ?? 'Someone';

/**
 * The right panel's "Pinned in #channel" (P31-07): the channel's pinned messages, the newest pin first. Each opens at its place in the channel (a reply opens its
 * thread); whoever can post in the channel unpins from here. The list follows pins made elsewhere (another tab, another person) through the store's pin hook.
 */
export function PinsPanel({ entry }: { entry: PanelEntry }) {
  const channelId = entry.id;
  const people = usePeople();
  const openMessage = useOpenMessage();
  const info = useQuery(`channel:${channelId}`, () => fetchChannel(channelId));
  const pins = useQuery(`pins:${channelId}`, () => fetchPins(channelId));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { reload } = pins;
  useEffect(() => channelStore.onPinChange((id) => (id === channelId ? reload() : undefined)), [channelId, reload]);
  // a deleted message loses its pin without a pin push, and an edit changes the text the list shows
  useEffect(() => channelStore.onMessageChange((c) => (pinsListChanged(c, channelId) ? reload() : undefined)), [channelId, reload]);

  const channel = info.status === 'ok' ? info.data.channel : null;
  const dm = channel !== null && channel.kind !== 'channel';
  usePanelTitle(channel ? (dm ? 'Pinned in this conversation' : `Pinned in #${channel.name.replace(/^#/, '')}`) : 'Pinned messages');
  const canPost = info.status === 'ok' && info.data.canPost && info.data.channel.archivedAt === null;

  if (pins.status === 'error') {
    return (
      <div className="panel-empty" role="alert">
        <p className="panel-empty-title">Could not load the pinned messages.</p>
        <p className="panel-empty-body">Close the panel and open it again to try once more.</p>
      </div>
    );
  }
  if (pins.status === 'loading') return <div className="pnp" aria-busy="true"><p className="chd-note">Loading…</p></div>;
  const items = pins.data.items;

  const unpin = async (m: ChannelMessage): Promise<void> => {
    setBusy(m.id);
    setProblem(null);
    try {
      await channelStore.setPin(channelId, m.id, false);
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : 'Could not unpin it. Try again.');
    } finally {
      setBusy(null);
    }
  };
  const open = (m: ChannelMessage): void => {
    if (!channel) return;
    const kind = channel.kind === 'dm' ? 'dm' : channel.kind === 'bot_conversation' ? 'bot_conversation' : 'channel';
    void openMessage({ channelId, channelKind: kind, channelName: kind === 'channel' ? channel.name : null, teamId: channel.teamId, messageId: m.id, threadRootId: m.threadRootId }, [entry]);
  };

  return (
    <div className="pnp" data-testid="pins-panel">
      {problem ? <p className="chn-error" role="alert">{problem}</p> : null}
      {items.length === 0 ? (
        <div className="panel-empty" data-testid="pins-empty">
          <p className="panel-empty-title"><PinMessageIcon /> Nothing is pinned yet</p>
          <p className="panel-empty-body">{canPost ? 'Pin a message from its More menu to keep it here for everyone in the channel.' : 'When someone pins a message, it shows here.'}</p>
        </div>
      ) : (
        <ul className="pnp-list" aria-label="Pinned messages">
          {items.map((m) => {
            const name = authorName(m, people);
            const person = m.author?.kind === 'bot' || m.author?.kind === 'system' ? undefined : people.byActor(m.authorId);
            return (
              <li key={m.id} className="pnp-row" data-testid="pin-row" data-message-id={m.id}>
                <div className="pnp-head">
                  {person ? <Avatar name={name} avatar={person.avatar} personId={person.personId} /> : <Avatar name={name} kind={m.author?.kind === 'bot' || m.author?.kind === 'system' ? 'agent' : 'person'} avatar={m.author?.kind === 'bot' ? people.botAvatar(m.authorId) : null} />}
                  <span className="pnp-name">{name}</span>
                  <time className="pnp-time" dateTime={m.createdAt} data-vt-mask>{fullStamp(m.createdAt)}</time>
                  {m.threadRootId ? <span className="pnp-reply">in a thread</span> : null}
                </div>
                <p className="pnp-text">{pinExcerpt(m) || 'A message with no text'}</p>
                <div className="pnp-acts">
                  <button type="button" className="btn s" data-testid="pin-open" disabled={!channel} onClick={() => open(m)}>Open</button>
                  {canPost ? (
                    <button type="button" className="btn s quiet" data-testid="pin-unpin" disabled={busy === m.id} aria-label={`Unpin the message from ${name}`} onClick={() => void unpin(m)}>
                      <UnpinMessageIcon /> Unpin
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
