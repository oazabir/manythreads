import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { leaveChannel, saveChannelHelp } from '../api/endpoints';
import { announceChannelChanged } from '../channels/slashDeps';
import { StandupDialog } from '../channels/StandupDialog';
import { ChannelLevelOptions } from '../notifications/ChannelBell';
import { WebhooksDialog } from '../webhooks/WebhooksDialog';
import { isMockMode } from '../api/setup';
import { usePanel } from '../kernel/panel';
import { notifyScheduledChanged } from '../meetings/schedule/changed';
import { ScheduleRoomDialog } from '../meetings/schedule/ScheduleRoomDialog';
import { HeadphonesIcon, PhoneIcon } from '../meetings/icons';
import { useHeaderItems, type HeaderMenuEntry, type HeaderToolKey } from './headerMenu';
import { MembersList } from './MembersButton';
import { MEMBERS_PANEL } from './membersModel';
import { useShell } from './context';
import { FULL_STARS_TEXT, isStarred, starPatch } from './sidebarLayout';
import { sidebarPrefsStore, useSidebarPrefs } from './sidebarPrefsStore';
import { BoardsIcon, BookmarkIcon, CaretIcon, MembersIcon, PinMessageIcon, ScheduleCalendarIcon, SearchIcon, StarIcon } from './icons';
import { PINS_PANEL } from '../channels/pinsModel';
import { useDismiss } from './useDismiss';

const TOOL_ICON: Record<HeaderToolKey, (dm: boolean) => ReactNode> = {
  search: () => <SearchIcon />,
  planned: () => <ScheduleCalendarIcon />,
  voice: (dm) => (dm ? <PhoneIcon /> : <HeadphonesIcon />),
  members: () => <MembersIcon />,
  bookmark: () => <BookmarkIcon />,
};

/**
 * The channel's name in the header, as a button that opens the channel's details (P21-06): notifications, star, pinned messages (P31-07), members, integrations,
 * files and Leave. It replaces the separate star, bell and Integrations buttons the header used to carry. A direct message has Notifications and Pinned messages only.
 * On a phone the header is the name and the bell (owner, 2026-11-19, P34-05): the menu starts with the header's tools (search, the planned room, the voice room,
 * Members, Add a bookmark), each doing what its hidden button does (`headerMenu.ts`); the CSS shows those items only when the header's `data-room` is `phone`.
 */
export function ChannelDetails({ channelId, name, teamSlug, dm, canManage, label, lead, trail, botBoard, help = false }: {
  channelId: string;
  name: string;
  teamSlug: string;
  dm: boolean;
  canManage: boolean;
  /** What the button says: `#dev`, or the other person in a direct message. */
  label: string;
  /** Drawn before the name inside the button (a direct message: the person's avatar with the presence dot). */
  lead?: ReactNode;
  /** Drawn after the button, outside it (a direct message: status and local time). */
  trail?: ReactNode;
  /** The channel's Bot Board, when it has one: a phone has no room for its icon in the header, so the menu carries it (P33-01). */
  botBoard?: { to: string; name: string } | undefined;
  /** A help channel (P18-09): its composer shows earlier answers. A lead turns it on and off here. */
  help?: boolean;
}) {
  const { guest } = useShell();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'notify' | 'members'>('menu');
  const [hooks, setHooks] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [standup, setStandup] = useState(false);
  const panel = usePanel();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const close = (): void => {
    setOpen(false);
    setView('menu');
    setConfirmLeave(false);
  };
  useDismiss(open, close, box);
  // Keyboard: opening (or switching view) puts focus on the first item; closing from inside gives it back to the name button.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      // the first item that is drawn: the header's tools are in the menu on a phone only, and a hidden button cannot take the focus
      [...(box.current?.querySelectorAll<HTMLElement>('.chd-menu button, .chd-menu a') ?? [])].find((el) => getComputedStyle(el).display !== 'none' && !(el as HTMLButtonElement).disabled)?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      if (box.current?.contains(document.activeElement) || document.activeElement === document.body) trigger.current?.focus();
    }
  }, [open, view]);
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
  const toggleHelp = (): void => {
    saveChannelHelp(channelId, !help).then(() => {
      announceChannelChanged(channelId);
      close();
    }, (e: unknown) => setProblem(e instanceof Error ? e.message : 'Could not change the channel. Try again.'));
  };
  const tools = useHeaderItems(channelId);
  const hasMembersTool = tools.some((t) => t.key === 'members');
  // the keyboard goes to the name button first: a dialog the tool opens gives it back there, and a box that takes the focus (the search) takes it from there
  const runTool = (t: HeaderMenuEntry): void => {
    close();
    trigger.current?.focus();
    t.run();
  };
  const target = useMemo(() => ({ channelId, channelName: dm ? null : name, channelKind: dm ? ('dm' as const) : ('channel' as const) }), [channelId, name, dm]);
  return (
    <div className="chd" ref={box}>
      <button type="button" ref={trigger} className="chd-btn" aria-haspopup="menu" aria-expanded={open} data-testid="channel-details-button" onClick={() => (open ? close() : setOpen(true))}>
        {lead}
        <span className="chd-name">{label}</span>
        <CaretIcon open={open} />
      </button>
      {trail}
      {open ? (
        <div className="chd-menu" role="menu" aria-label="Channel details" data-testid="channel-details">
          {view === 'menu' ? (
            <>
              {tools.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="menuitem"
                  className="menu-item chd-head-tool"
                  data-testid={t.testId}
                  disabled={t.disabled}
                  {...(t.popup ? { 'aria-haspopup': 'dialog' as const } : {})}
                  {...(t.pressed !== undefined ? { 'aria-pressed': t.pressed } : {})}
                  onClick={() => runTool(t)}
                >
                  {TOOL_ICON[t.key](dm)} {t.label}
                </button>
              ))}
              <button type="button" role="menuitem" className="menu-item" data-testid="details-notifications" onClick={() => setView('notify')}>Notifications</button>
              {!dm && !guest && prefs.status === 'ok' ? (
                <button type="button" role="menuitem" className="menu-item" data-testid="channel-star" aria-pressed={starred} onClick={toggleStar}>
                  <StarIcon filled={starred} /> {starred ? 'Unstar' : 'Star'}
                </button>
              ) : null}
              {/* the channel's pinned messages (P31-07), in the right panel; the same item on a phone, where this menu also holds the header's tools (P34-05) */}
              <button type="button" role="menuitem" className="menu-item" data-testid="details-pins" onClick={() => { close(); panel.push({ type: PINS_PANEL, id: channelId }); }}><PinMessageIcon /> Pinned messages</button>
              {/* on a phone the Members tool above opens the panel, so this list view (which links to the same panel) steps aside */}
              {!dm ? <button type="button" role="menuitem" className={`menu-item${hasMembersTool ? ' chd-head-twin' : ''}`} data-testid="details-members" onClick={() => setView('members')}>Members</button> : null}
              {!dm && botBoard ? (
                <Link role="menuitem" className="menu-item chd-phone-only" data-testid="details-bot-board" to={botBoard.to} onClick={close}><BoardsIcon /> {botBoard.name}</Link>
              ) : null}
              {!dm && !isMockMode() ? (
                <button type="button" role="menuitem" className="menu-item chd-phone-only" data-testid="details-schedule" aria-haspopup="dialog" onClick={() => { close(); setScheduling(true); }}><ScheduleCalendarIcon /> Schedule a room</button>
              ) : null}
              {!dm && canManage ? (
                <button type="button" role="menuitem" className="menu-item" data-testid="details-help" aria-pressed={help} onClick={toggleHelp}>
                  {help ? 'Stop being a help channel' : 'Make this a help channel'}
                </button>
              ) : null}
              {!dm && canManage ? (
                <button type="button" role="menuitem" className="menu-item" data-testid="details-standup" aria-haspopup="dialog" onClick={() => { close(); setStandup(true); }}>
                  Stand-up…
                </button>
              ) : null}
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
              {!guest ? <button type="button" role="menuitem" className="menu-item" data-testid="details-members-panel" onClick={() => { close(); panel.push({ type: MEMBERS_PANEL, id: channelId }); }}><MembersIcon /> Open the member list</button> : null}
              <MembersList channelId={channelId} />
            </>
          )}
          {problem ? <p className="chn-error" role="alert">{problem}</p> : null}
        </div>
      ) : null}
      {scheduling ? <ScheduleRoomDialog channelId={channelId} channelLabel={`#${name}`} onClose={() => setScheduling(false)} onCreated={() => { setScheduling(false); notifyScheduledChanged(channelId); }} /> : null}
      {standup ? <StandupDialog channelId={channelId} channelName={name} teamSlug={teamSlug} onClose={() => setStandup(false)} /> : null}
      {hooks ? <WebhooksDialog channelId={channelId} channelName={name} onClose={() => setHooks(false)} /> : null}
    </div>
  );
}
