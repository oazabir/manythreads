import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LEVEL_LABEL, type NotificationLevel } from '@manythreads/shared';
import { BellIcon, BellOffIcon } from '../shell/icons';
import { useDismiss } from '../shell/useDismiss';
import { levelsStore } from './levelsStore';
import { LEVEL_HELP, LEVEL_ORDER, levelOf } from './settingsModel';

export type ChannelBellTarget = { channelId: string; channelName: string | null; channelKind: 'channel' | 'dm' | 'bot_conversation' };

/**
 * The bell in a channel's header: what this channel may interrupt the person with. Three levels (all messages, mentions and keywords only,
 * nothing) and "Use the default", which takes their own choice away. Absent only when the levels cannot be loaded (a server without them).
 */
export function ChannelBell({ channel }: { channel: ChannelBellTarget }) {
  const snap = useSyncExternalStore(levelsStore.subscribe, levelsStore.snapshot);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  useEffect(() => {
    void levelsStore.load();
  }, []);

  // Present from the first paint (a header that gains a button a moment later jumps), with the default level until the person's own is known.
  if (snap.status === 'error') return null;
  const { own, effective } = levelOf(snap.levels, channel.channelId, channel.channelKind);
  const choose = async (level: NotificationLevel | null): Promise<void> => {
    setError(null);
    try {
      await levelsStore.setChannel(channel, level);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the setting.');
    }
  };
  return (
    <div className="chn" ref={box} data-testid="channel-bell">
      <button
        type="button"
        className="icon-btn chn-btn"
        aria-label={`Notifications for this channel: ${LEVEL_LABEL[effective]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={snap.levels === null || undefined}
        data-testid="channel-bell-button"
        data-level={effective}
        onClick={() => setOpen((o) => !o)}
      >
        {effective === 'nothing' ? <BellOffIcon /> : <BellIcon />}
        {effective === 'all' ? <span className="chn-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="chn-menu" role="menu" aria-label="Notifications for this channel">
          {LEVEL_ORDER.map((level) => (
            <button key={level} type="button" role="menuitemradio" aria-checked={effective === level} className="chn-opt" data-testid={`level-${level}`} onClick={() => void choose(level)}>
              <span className="chn-name">{LEVEL_LABEL[level]}{effective === level ? <span className="chn-check" aria-hidden="true"> ✓</span> : null}</span>
              <span className="chn-help">{LEVEL_HELP[level]}</span>
            </button>
          ))}
          {own !== null ? (
            <button type="button" role="menuitem" className="chn-opt chn-reset" data-testid="level-default" onClick={() => void choose(null)}>
              <span className="chn-name">Use the default</span>
            </button>
          ) : null}
          {error ? <p className="chn-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
