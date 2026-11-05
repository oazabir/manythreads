import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { leaveChannel } from '../api/endpoints';
import { ChannelLevelOptions } from '../notifications/ChannelBell';
import { WebhooksDialog } from '../webhooks/WebhooksDialog';
import { MembersList } from './MembersStack';
import { useShell } from './context';
import { FULL_STARS_TEXT, isStarred, starPatch } from './sidebarLayout';
import { sidebarPrefsStore, useSidebarPrefs } from './sidebarPrefsStore';
import { CaretIcon, StarIcon } from './icons';
import { useDismiss } from './useDismiss';

/**
 * The channel's name in the header, as a button that opens the channel's details (P21-06): notifications, star, members, integrations, files and
 * Leave. It replaces the separate star, bell and Integrations buttons the header used to carry. A direct message has the notifications choice only.
 */
export function ChannelDetails({ channelId, name, teamSlug, dm, canManage, label }: {
  channelId: string;
  name: string;
  teamSlug: string;
  dm: boolean;
  canManage: boolean;
  /** What the button says: `#dev`, or the other person in a direct message. */
  label: string;
}) {
  const { guest } = useShell();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'notify' | 'members'>('menu');
  const [hooks, setHooks] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = (): void => {
    setOpen(false);
    setView('menu');
    setConfirmLeave(false);
  };
  useDismiss(open, close, box);
  const prefs = useSidebarPrefs(teamSlug, !guest && !dm);
  const starred = prefs.status === 'ok' && isStarred(prefs.prefs.starred, channelId);
  const toggleStar = (): void => {
    if (prefs.status !== 'ok') return;
    const patch = starPatch(prefs.prefs.starred, channelId, !starred);
    if (!patch) {
      setProblem(FULL_STARS_TEXT);
      return;
    }
    setProblem(null);
    sidebarPrefsStore.update(teamSlug, patch).then(close, (e: unknown) => setProblem(e instanceof Error ? e.message : 'Could not save your sidebar. Try again.'));
  };
  const leave = (): void => {
    leaveChannel(channelId).then(() => {
      close();
      void navigate(`/t/${encodeURIComponent(teamSlug)}`);
    }, (e: unknown) => setProblem(e instanceof Error ? e.message : 'Could not leave the channel. Try again.'));
  };
  const target = useMemo(() => ({ channelId, channelName: dm ? null : name, channelKind: dm ? ('dm' as const) : ('channel' as const) }), [channelId, name, dm]);
  return (
    <div className="chd" ref={box}>
      <button type="button" className="chd-btn" aria-haspopup="menu" aria-expanded={open} data-testid="channel-details-button" onClick={() => (open ? close() : setOpen(true))}>
        <span className="chd-name">{label}</span>
        <CaretIcon open={open} />
      </button>
      {open ? (
        <div className="chd-menu" role="menu" aria-label="Channel details" data-testid="channel-details">
          {view === 'menu' ? (
            <>
              <button type="button" role="menuitem" className="menu-item" data-testid="details-notifications" onClick={() => setView('notify')}>Notifications</button>
              {!dm && !guest && prefs.status === 'ok' ? (
                <button type="button" role="menuitem" className="menu-item" data-testid="channel-star" aria-pressed={starred} onClick={toggleStar}>
                  <StarIcon filled={starred} /> {starred ? 'Unstar' : 'Star'}
                </button>
              ) : null}
              {!dm ? <button type="button" role="menuitem" className="menu-item" data-testid="details-members" onClick={() => setView('members')}>Members</button> : null}
              {!dm && canManage ? (
                <button type="button" role="menuitem" className="menu-item" data-testid="webhooks-open" aria-haspopup="dialog" onClick={() => { close(); setHooks(true); }}>Integrations</button>
              ) : null}
              {!dm && !guest ? (
                <Link role="menuitem" className="menu-item" data-testid="details-files" to={`/t/${encodeURIComponent(teamSlug)}/files?open=${encodeURIComponent(`channels/${name}`)}`} onClick={close}>Files</Link>
              ) : null}
              {!dm && !guest ? (
                confirmLeave ? (
                  <button type="button" role="menuitem" className="menu-item danger" data-testid="details-leave-confirm" onClick={leave}>Leave #{name}? Press again to confirm</button>
                ) : (
                  <button type="button" role="menuitem" className="menu-item danger" data-testid="details-leave" onClick={() => setConfirmLeave(true)}>Leave channel</button>
                )
              ) : null}
            </>
          ) : view === 'notify' ? (
            <>
              <button type="button" className="menu-item" onClick={() => setView('menu')}>Back</button>
              <ChannelLevelOptions channel={target} onDone={close} />
            </>
          ) : (
            <>
              <button type="button" className="menu-item" onClick={() => setView('menu')}>Back</button>
              <MembersList channelId={channelId} />
            </>
          )}
          {problem ? <p className="chn-error" role="alert">{problem}</p> : null}
        </div>
      ) : null}
      {hooks ? <WebhooksDialog channelId={channelId} channelName={name} onClose={() => setHooks(false)} /> : null}
    </div>
  );
}
