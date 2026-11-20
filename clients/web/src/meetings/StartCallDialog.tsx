import { useEffect, useId, useRef, useState } from 'react';
import { CALL_INVITES_MAX, type CallStartOptionsResponse } from '@manythreads/shared';
import { Dialog } from '../components/Dialog';
import { Toggle } from '../components/ui';
import { fetchCallOptions, inviteToMeeting } from './api';
import { callCards } from './callCards';
import { PeopleChecklist } from './PeopleChecklist';
import { tooManyLine, type ChecklistPerson } from './people';
import { CONSENT_LINE, DM_LINE, FIND_PAUSE_MS, START_TITLE_MAX, buildStartBody, searchFailure, checklistPeople, dialogFailure, isNotetakerRefusal, notetakerChoice } from './startCall';
import { callController, useCall } from './store';

/*
 * Starting a call (P15-25) and asking more people to one (P15-27). Both read `GET /api/channels/:id/calls/options`: the people who can read the channel, the caller
 * first. A long channel is cut at 200 by the server; the find box then asks the server again, with a pause between keys, and otherwise filters the list here.
 */

type Loaded = { status: 'loading' } | { status: 'error' } | { status: 'ok'; options: CallStartOptionsResponse };

/** The options of a channel, and the people to list for what is typed in the find box (asked again on the server when its first answer was cut short). */
export function useCallPeople(channelId: string, o: { withCaller: boolean }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [find, setFind] = useState('');
  const [searched, setSearched] = useState<{ q: string; status: 'ok' | 'failed'; people: CallStartOptionsResponse['people']; peopleTotal: number; why: string | null } | null>(null);
  const asked = useRef(0);

  useEffect(() => {
    let live = true;
    fetchCallOptions(channelId).then(
      (options) => live && setLoaded({ status: 'ok', options }),
      () => live && setLoaded({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [channelId]);

  const base = loaded.status === 'ok' ? loaded.options : null;
  const capped = base !== null && base.peopleTotal > base.people.length;
  const q = find.trim();
  // every key asks again (after the pause), so a search that failed is tried again by the next key
  useEffect(() => {
    if (!capped || q === '') return;
    const n = ++asked.current;
    setSearched((was) => (was && was.q === q && was.status === 'failed' ? null : was));
    const t = setTimeout(() => {
      fetchCallOptions(channelId, q).then(
        (res) => n === asked.current && setSearched({ q, status: 'ok', people: res.people, peopleTotal: res.peopleTotal, why: null }),
        (e: unknown) => n === asked.current && setSearched({ q, status: 'failed', people: [], peopleTotal: 0, why: searchFailure(e) }),
      );
    }, FIND_PAUSE_MS);
    return () => clearTimeout(t);
  }, [capped, q, find, channelId]);

  // the answer counts only for what is typed now: while the search for it is out, or failed, the list shows nobody rather than an earlier search's people
  const current = capped && q !== '' ? (searched?.q === q ? searched : null) : null;
  const searching = capped && q !== '' && current === null;
  const searchFailed = current?.status === 'failed' ? current.why : null;
  const source = base === null ? [] : capped && q !== '' ? (current?.status === 'ok' ? current.people : []) : base.people;
  const rows = checklistPeople(source).filter((p) => o.withCaller || !p.locked);
  // the server counts the caller; a list without them counts one fewer
  const less = !o.withCaller && base?.people.some((p) => p.you) ? 1 : 0;
  const server = capped && base ? { matching: Math.max(0, (q === '' ? base.peopleTotal : (current?.peopleTotal ?? 0)) - less), total: Math.max(0, base.peopleTotal - less) } : undefined;
  return { loaded, find, setFind, rows, server, searching, searchFailed };
}

/**
 * The start dialog: a title (filled in with the server's default), the people to ask, the guest link (not built yet), the note-taker (on by default when one may
 * come) and Start call. A refusal stays in the dialog with the server's reason; one about the note-taker turns its switch off. In a direct message nobody is listed:
 * everyone in it is rung. `onClose` runs on Cancel and Esc; `onStarted` (else `onClose`) once a call has been started or joined, so the opener can put the
 * keyboard on the call bar. At most 100 people can be asked; Start call says so instead of sending more.
 */
export function StartCallDialog({ channelId, onClose, onStarted }: { channelId: string; onClose: () => void; onStarted?: () => void }) {
  const { loaded, find, setFind, rows, server, searching, searchFailed } = useCallPeople(channelId, { withCaller: true });
  const call = useCall();
  const elsewhere = call.meeting !== null && call.meeting.channelId !== channelId && (call.phase === 'connected' || call.phase === 'reconnecting' || call.phase === 'lost');
  const started = onStarted ?? onClose;
  const joinBtn = useRef<HTMLButtonElement>(null);
  const options = loaded.status === 'ok' ? loaded.options : null;
  const [title, setTitle] = useState('');
  const touched = useRef(false);
  const titleBox = useRef<HTMLInputElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [noteOn, setNoteOn] = useState(true);
  const [botId, setBotId] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const noteId = useId();
  const guestId = useId();

  // the server's default title comes in once the options answer, unless the person has already typed one; it is selected so typing replaces it
  useEffect(() => {
    if (!options || touched.current) return;
    setTitle(options.defaultTitle.slice(0, START_TITLE_MAX));
    requestAnimationFrame(() => {
      if (document.activeElement === titleBox.current) titleBox.current?.select();
    });
  }, [options]);

  const blocked = options !== null && !options.canStart;
  const liveHere = options?.live ?? null;
  // with no form left to type in, the keyboard goes to Close
  useEffect(() => {
    if (blocked || joined) closeBtn.current?.focus();
  }, [blocked, joined]);
  // a call already going: the keyboard goes to its Join call, so it stays inside the dialog
  useEffect(() => {
    if (liveHere && !blocked && !joined) joinBtn.current?.focus();
  }, [liveHere, blocked, joined]);

  const choice = options ? notetakerChoice(options.notetaker) : { offered: false, defaultBotId: null, reason: null };
  const offered = choice.offered && refused === null;
  const on = offered && noteOn;
  const bots = options?.notetaker.bots ?? [];
  const bot = bots.find((b) => b.botId === (botId ?? choice.defaultBotId)) ?? null;
  const dm = options?.directMessage === true;
  const lockedIds = rows.filter((p) => p.locked).map((p) => p.personId);
  const asking = dm ? 0 : picked.filter((id) => !lockedIds.includes(id)).length;
  const tooMany = asking > CALL_INVITES_MAX;

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const body = buildStartBody({ title, picked, lockedIds, dm, notetakerBotId: on ? (bot?.botId ?? null) : null });
    try {
      const res = await callController().startFromDialog(channelId, body);
      if (!res.created) setJoined(true);
      else started();
    } catch (e) {
      const said = dialogFailure(e, 'The call could not start. Try again.');
      if (on && isNotetakerRefusal(said)) setRefused(said);
      setError(said);
    } finally {
      setBusy(false);
    }
  };
  const joinLive = (): void => {
    if (liveHere) void callController().joinRoom(liveHere.meetingId, channelId);
    started();
  };

  const footer = blocked || joined ? (
    <button type="button" ref={closeBtn} className="btn" onClick={joined ? started : onClose} data-testid="call-start-close">Close</button>
  ) : liveHere ? (
    <>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" ref={joinBtn} className="btn primary" onClick={joinLive} data-testid="call-start-join">Join call</button>
    </>
  ) : (
    <>
      <button type="button" className="btn" onClick={onClose} data-testid="call-start-cancel">Cancel</button>
      <button
        type="button"
        className="btn primary"
        disabled={busy || loaded.status === 'loading' || tooMany}
        title={tooMany ? tooManyLine(CALL_INVITES_MAX) : undefined}
        onClick={() => void start()}
        data-testid="call-start-submit"
      >
        {busy ? 'Starting…' : 'Start call'}
      </button>
    </>
  );

  return (
    <Dialog title="Start an audio call" onClose={onClose} testId="call-start-dialog" sheet footer={footer}>
      {joined ? (
        <p className="dlg-text" role="status" data-testid="call-start-joined">
          A call was already going: you joined it. Nobody was invited — use Invite more on its card. The note-taker choice was not used.
        </p>
      ) : blocked ? (
        <p className="dlg-text" data-testid="call-start-blocked">{options?.reason ?? 'You cannot start a call here.'}</p>
      ) : liveHere ? (
        <p className="dlg-text" data-testid="call-start-live">A call is already going here: <b>{liveHere.title}</b>.</p>
      ) : (
        <div className="dlg-form scd-form">
          <label className="dlg-label" htmlFor={`${noteId}-title`}>Title</label>
          <input
            id={`${noteId}-title`}
            ref={titleBox}
            className="dlg-input"
            value={title}
            maxLength={START_TITLE_MAX}
            onChange={(e) => {
              touched.current = true;
              setTitle(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy && loaded.status !== 'loading' && !tooMany) {
                e.preventDefault();
                void start();
              }
            }}
            data-autofocus
            data-testid="call-start-title"
          />

          {elsewhere ? <p className="dlg-hint" data-testid="call-start-elsewhere">You are in another call. You leave it once this one has opened.</p> : null}
          {loaded.status === 'loading' ? <p className="dlg-hint" role="status">Finding who can be asked…</p> : null}
          {loaded.status === 'error' ? <p className="dlg-hint" role="status">Who can be asked could not be loaded. You can still start the call.</p> : null}

          {options && dm ? <p className="dlg-hint scd-dm" data-testid="call-start-dm">{DM_LINE}</p> : null}
          {options && !dm ? (
            <>
              <PeopleChecklist
                label="Invite people"
                people={rows}
                picked={picked}
                onChange={setPicked}
                find={find}
                onFind={setFind}
                server={server}
                searching={searching}
                searchFailed={searchFailed}
                max={CALL_INVITES_MAX}
                maxLine={tooManyLine(CALL_INVITES_MAX)}
                emptyText="Nobody else can read this channel."
                testId="call-start-people"
                findTestId="call-start-find"
              />
              <p className="dlg-hint" data-testid="call-start-asking">{asking === 0 ? 'Nobody invited: the call is open to everyone in the channel.' : `${asking} invited. They get a notification.`}</p>
            </>
          ) : null}

          {options ? (
            <>
              <div className="scd-switch">
                <Toggle checked={false} onChange={() => undefined} label="Guest link" locked describedBy={guestId} testId="call-start-guests" />
                <div className="scd-switch-text">
                  <span className="scd-switch-name">Guest link</span>
                  <span className="dlg-hint" id={guestId}>{options.guestLinks.reason}</span>
                </div>
              </div>
              <div className="scd-switch">
                <Toggle checked={on} onChange={setNoteOn} label={bot && on ? `Note-taker: ${bot.name}` : 'Note-taker'} locked={!offered} describedBy={`${noteId}-why`} testId="call-start-notetaker" />
                <div className="scd-switch-text">
                  <span className="scd-switch-name" data-testid="call-start-notetaker-name">{bot && offered && bots.length === 1 ? `Note-taker: ${bot.name}` : 'Note-taker'}</span>
                  {offered && bots.length > 1 ? (
                    <select className="dlg-input scd-bot" aria-label="Which note-taker" value={bot?.botId ?? ''} disabled={!on} onChange={(e) => setBotId(e.target.value)} data-testid="call-start-notetaker-bot">
                      {bots.map((b) => (<option key={b.botId} value={b.botId}>{b.name}</option>))}
                    </select>
                  ) : null}
                  <span className="dlg-hint" id={`${noteId}-why`}>
                    {offered ? `${CONSENT_LINE}.` : `${refused ?? choice.reason ?? 'A note-taker cannot come now.'} ${CONSENT_LINE}.`}
                  </span>
                </div>
              </div>
            </>
          ) : null}

          {error ? <p className="dlg-error" role="alert" data-testid="call-start-error">{error}</p> : null}
        </div>
      )}
    </Dialog>
  );
}

/**
 * "Invite more" on a live call's card (P15-27): the people of the channel to tick (the caller left out: they are in it), and Invite. The card asks for itself
 * again so the invited names show; people asked before are left out by the server.
 */
export function InviteMoreDialog({ meetingId, channelId, onClose }: { meetingId: string; channelId: string; onClose: () => void }) {
  const { loaded, find, setFind, rows, server, searching, searchFailed } = useCallPeople(channelId, { withCaller: false });
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [none, setNone] = useState(false);

  const invite = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNone(false);
    try {
      const res = await inviteToMeeting(meetingId, picked);
      await callCards().refresh(meetingId);
      if (res.invited.length === 0) setNone(true);
      else onClose();
    } catch (e) {
      setError(dialogFailure(e, 'Could not invite them. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const people: ChecklistPerson[] = rows;
  return (
    <Dialog
      title="Invite more people"
      onClose={onClose}
      testId="call-invite-dialog"
      sheet
      startAtTop
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} data-testid="call-invite-cancel">Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || picked.length === 0 || picked.length > CALL_INVITES_MAX}
            title={picked.length > CALL_INVITES_MAX ? tooManyLine(CALL_INVITES_MAX) : undefined}
            onClick={() => void invite()}
            data-testid="call-invite-submit"
          >
            {busy ? 'Inviting…' : picked.length > 1 ? `Invite ${picked.length}` : 'Invite'}
          </button>
        </>
      }
    >
      <div className="dlg-form scd-form">
        {loaded.status === 'loading' ? <p className="dlg-hint" role="status">Finding who can be asked…</p> : null}
        {loaded.status === 'error' ? <p className="dlg-error" role="alert">Who can be asked could not be loaded. Close this and try again.</p> : null}
        {loaded.status === 'ok' ? (
          <PeopleChecklist
            label="People in this channel"
            people={people}
            picked={picked}
            onChange={setPicked}
            find={find}
            onFind={setFind}
            server={server}
            searching={searching}
            searchFailed={searchFailed}
            max={CALL_INVITES_MAX}
            maxLine={tooManyLine(CALL_INVITES_MAX)}
            emptyText="Nobody else can read this channel."
            testId="call-invite-people"
            findTestId="call-invite-find"
          />
        ) : null}
        <p className="dlg-hint">They get a notification. Anyone who can read the channel may join, invited or not.</p>
        {none ? <p className="dlg-hint" role="status" data-testid="call-invite-none">Everyone you picked was already invited.</p> : null}
        {error ? <p className="dlg-error" role="alert" data-testid="call-invite-error">{error}</p> : null}
      </div>
    </Dialog>
  );
}
