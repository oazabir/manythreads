import { useEffect, useId, useState } from 'react';
import { usePeople } from '../channels/hooks';
import { Avatar } from '../components/ui';
import { useNarrow } from '../shell/useNarrow';
import type { CallState } from './controller';
import { canTurnOn, consentChip, consentWord, modeToTurnOn, promptCopy } from './consent';
import { engineAvailable } from './engine';
import { Captions, EngineNotice } from './Captions';
import { CaptionsIcon, ChatIcon, HeadphonesIcon, LeaveIcon, MicIcon, SlidersIcon } from './icons';
import { NOT_SET_UP_HELP, NOT_SET_UP_TITLE, callClock, notetakerBadge, rosterOf, visibleCaptions } from './model';
import { NotetakerButton, NotetakerMenu } from './NotetakerPicker';
import { RecordConsentPrompt, RecordingChip, RecordingToggle } from './RecordingToggle';
import { callController, useCall } from './store';

/*
 * The docked call bar (PLAN P15-04, P15-05): at the bottom of the centre column while a person is in a voice room; at 390 px a sheet that rises from the bottom
 * edge. Mute, deafen, devices and push-to-talk, captions, the transcription chip, Chat with its unread count, Leave. A room that could not be started (no media server,
 * a refused connection) is a plain card in the same place, never an error page.
 */

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [active]);
  return now;
}

/** The card for "voice rooms are not set up", a failed start, or a lost connection. */
function StatusCard({ call }: { call: CallState }) {
  const c = callController();
  if (call.phase === 'not-set-up') {
    return (
      <section className="call-dock call-card" role="status" aria-label="Voice room" data-testid="call-not-set-up">
        <div className="call-card-text">
          <b className="call-card-title">{NOT_SET_UP_TITLE}</b>
          <span className="call-card-body">{NOT_SET_UP_HELP}</span>
        </div>
        <button type="button" className="btn s" onClick={() => c.dismiss()}>Close</button>
      </section>
    );
  }
  return (
    <section className="call-dock call-card" role="alert" aria-label="Voice room" data-testid="call-failed">
      <div className="call-card-text">
        <b className="call-card-title">Could not open the voice room</b>
        <span className="call-card-body">{call.error ?? 'Something went wrong. Try again.'}</span>
      </div>
      <button type="button" className="btn s" onClick={() => c.dismiss()}>Close</button>
    </section>
  );
}

function ConsentPrompt({ call }: { call: CallState }) {
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = call.transcription?.mode === 'server' ? 'server' : 'on_device';
  const by = call.consent.kind === 'ask' ? call.consent.by : null;
  const copy = promptCopy(by, mode, call.notetakers?.current?.bot.name ?? null);
  const choose = async (answer: 'yes' | 'no'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await callController().answerConsent(answer, { remember });
    } catch {
      setError('Could not save your answer. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="call-consent" role="group" aria-label={copy.title} data-testid="call-consent">
      <b className="call-consent-title">{copy.title}</b>
      <p className="call-consent-body">{copy.body}</p>
      <label className="call-consent-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Remember my answer for future calls</span>
      </label>
      {error ? <p className="call-consent-error" role="alert">{error}</p> : null}
      <div className="call-consent-actions">
        <button type="button" className="btn primary s" disabled={busy} onClick={() => void choose('yes')} data-testid="consent-yes">{copy.yes}</button>
        <button type="button" className="btn s" disabled={busy} onClick={() => void choose('no')} data-testid="consent-no">{copy.no}</button>
      </div>
      <span className="call-consent-wait">Your microphone opens after you answer.</span>
    </div>
  );
}

function Settings({ call, canEnd }: { call: CallState; canEnd: boolean }) {
  const c = callController();
  const ids = { mic: useId(), spk: useId(), def: useId() };
  const d = call.devices;
  const tr = call.transcription;
  const offer = engineAvailable() && tr !== null;
  return (
    <div className="call-menu" role="dialog" aria-label="Call settings" data-testid="call-settings">
      <label className="call-field" htmlFor={ids.mic}>
        <span>Microphone</span>
        <select id={ids.mic} value={d?.inputId ?? ''} onChange={(e) => void c.pickInput(e.target.value)} disabled={!d || d.inputs.length === 0}>
          {(d?.inputs ?? []).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          {!d || d.inputs.length === 0 ? <option value="">Default microphone</option> : null}
        </select>
      </label>
      <label className="call-field" htmlFor={ids.spk}>
        <span>Speakers</span>
        <select id={ids.spk} value={d?.outputId ?? ''} onChange={(e) => void c.pickOutput(e.target.value)} disabled={!d || d.outputs.length === 0}>
          {(d?.outputs ?? []).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          {!d || d.outputs.length === 0 ? <option value="">Default speakers</option> : null}
        </select>
      </label>
      <label className="call-check">
        <input type="checkbox" checked={call.pushToTalk} onChange={(e) => c.setPushToTalk(e.target.checked)} data-testid="ptt-toggle" />
        <span>Push to talk (hold Space, or the Hold to talk button)</span>
      </label>
      <label className="call-check">
        <input type="checkbox" checked={call.prefs.sounds} onChange={(e) => c.setSounds(e.target.checked)} />
        <span>Play a sound when people join or leave</span>
      </label>
      <p className="call-hint">Mute or unmute from anywhere with Ctrl+Shift+Space (Cmd+Shift+Space on a Mac). Echo cancellation and noise suppression are on.</p>
      {offer ? (
        <div className="call-sec">
          <label className="call-field" htmlFor={ids.def}>
            <span>“Transcribe my voice” when a call turns it on</span>
            <select id={ids.def} value={call.prefs.transcribeDefault} onChange={(e) => c.saveDefault(e.target.value as 'ask' | 'yes' | 'no')} data-testid="consent-default">
              <option value="ask">Ask me each time</option>
              <option value="yes">Always yes</option>
              <option value="no">Always no</option>
            </select>
          </label>
          {tr && canTurnOn(tr) ? (
            <button type="button" className="btn s" data-testid="transcription-on" onClick={() => void c.turnTranscription(modeToTurnOn(tr) ?? 'on_device')}>Turn on transcription</button>
          ) : tr && tr.mode !== 'off' ? (
            <button type="button" className="btn s" data-testid="transcription-off" onClick={() => void c.turnTranscription('off')}>Turn off transcription</button>
          ) : tr?.reason ? (
            <p className="call-hint" data-testid="transcription-reason">{tr.reason}</p>
          ) : null}
        </div>
      ) : null}
      {canEnd ? (
        <button type="button" className="btn s call-end-all" onClick={() => void c.endForAll()} data-testid="call-end-all">End for everyone</button>
      ) : null}
    </div>
  );
}

export function CallDock() {
  const call = useCall();
  const people = usePeople();
  const narrow = useNarrow();
  const [menu, setMenu] = useState<'settings' | 'notetaker' | null>(null);
  const [open, setOpen] = useState(false);
  const inRoom = call.phase === 'connected' || call.phase === 'reconnecting' || call.phase === 'connecting' || call.phase === 'lost';
  const now = useNow(call.phase === 'connected');
  if (call.phase === 'not-set-up' || call.phase === 'failed') return <StatusCard call={call} />;
  if (!inRoom || !call.meeting) return null;

  const c = callController();
  const roster = rosterOf(call.present, call.speaking, call.myActorId);
  const me = call.present.find((p) => p.actorId === call.myActorId);
  const notetaker = call.notetakers?.current ?? null;
  const chip = consentChip(call.transcription, me?.consentTranscribe ?? 'unasked', notetaker?.bot.name ?? null);
  const canEnd = call.meeting.startedBy === call.myActorId || people.canModerate;
  const connecting = call.phase === 'connecting';
  const lost = call.phase === 'lost';
  const sheetOpen = !narrow || open;
  const micLabel = call.deafened ? 'Unmute and listen again' : call.muted ? 'Unmute' : 'Mute';

  return (
    <section className={`call-dock ${narrow ? 'sheet' : ''} ${sheetOpen ? 'open' : ''}`} aria-label="Voice room" data-testid="call-dock" data-phase={call.phase}>
      {narrow ? (
        <button type="button" className="call-grab" aria-expanded={open} aria-label={open ? 'Hide call details' : 'Show call details'} onClick={() => setOpen((o) => !o)} />
      ) : null}
      {call.consent.kind === 'ask' && call.phase === 'connected' ? <ConsentPrompt call={call} /> : null}
      {call.phase === 'connected' ? <RecordConsentPrompt call={call} /> : null}
      <EngineNotice call={call} />
      {call.notice ? <p className="call-notice" role="status" data-testid="call-notice">{call.notice}</p> : null}
      <div className="call-row">
        <div className="call-id">
          <span className={`call-live ${lost ? 'off' : ''}`} aria-hidden="true" />
          <span className="call-title" title={call.meeting.title}>{call.meeting.title}</span>
          <span className="call-clock" data-vt-mask>{connecting ? 'Connecting…' : callClock(call.meeting.startedAt, now)}</span>
        </div>
        <ul className="call-faces" aria-label="People in the voice room" data-testid="call-roster">
          {roster.map((r) => (
            <li key={r.actorId} className={`call-face ${r.speaking ? 'speaking' : ''}`} data-speaking={r.speaking || undefined} data-testid="call-face" title={`${r.me ? 'You' : r.name}${r.speaking ? ' (speaking)' : ''}${call.transcription && call.transcription.mode !== 'off' ? ` · ${consentWord(r.consent)}` : ''}`}>
              <Avatar name={r.name} personId={r.personId} />
              <span className="call-face-name">{r.me ? 'You' : r.name}</span>
              {r.speaking ? <span className="sr-only">speaking</span> : null}
            </li>
          ))}
          {notetaker ? (
            <li className="call-face bot" data-testid="call-notetaker-face" title={`${notetaker.bot.name} · ${notetakerBadge(notetaker)}`}>
              <Avatar name={notetaker.bot.name} kind="agent" avatar={notetaker.bot.avatar} />
              <span className="call-face-name">{notetaker.bot.name}</span>
              <span className={`call-nt-badge ${notetaker.listening ? 'on' : ''}`} data-testid="call-notetaker-badge">{notetakerBadge(notetaker)}</span>
            </li>
          ) : null}
        </ul>
        <RecordingChip call={call} />
        {chip ? <span className={`call-chip ${chip.tone}`} title={chip.title} data-testid="call-chip">{chip.label}</span> : null}
        <div className="call-controls">
          {lost ? (
            <button type="button" className="btn primary s" onClick={() => void c.rejoin()} data-testid="call-rejoin">Rejoin</button>
          ) : (
            <>
              <button type="button" className={`call-btn ${call.muted ? 'on' : ''}`} aria-pressed={call.muted} aria-label={micLabel} title={`${micLabel} (Ctrl+Shift+Space)`} disabled={connecting} onClick={() => c.toggleMute()} data-testid="call-mute">
                <MicIcon off={call.muted} />
              </button>
              <button type="button" className={`call-btn ${call.deafened ? 'on' : ''}`} aria-pressed={call.deafened} aria-label={call.deafened ? 'Hear the room again' : 'Deafen: stop hearing the room'} title={call.deafened ? 'Hear the room again' : 'Deafen'} disabled={connecting} onClick={() => c.toggleDeafen()} data-testid="call-deafen">
                <HeadphonesIcon off={call.deafened} />
              </button>
              {call.pushToTalk ? (
                <button
                  type="button"
                  className={`btn s call-ptt ${call.talking ? 'talking' : ''}`}
                  data-testid="call-ptt"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                    c.talk(true);
                  }}
                  onPointerUp={() => c.talk(false)}
                  onPointerCancel={() => c.talk(false)}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  Hold to talk
                </button>
              ) : null}
            </>
          )}
          <button type="button" className={`call-btn ${call.prefs.captions ? 'on' : ''}`} aria-pressed={call.prefs.captions} aria-label="Captions" title="Captions" onClick={() => c.setCaptions(!call.prefs.captions)} data-testid="call-captions">
            <CaptionsIcon />
          </button>
          <RecordingToggle call={call} />
          <div className="call-more">
            <NotetakerButton call={call} open={menu === 'notetaker'} onToggle={() => setMenu((m) => (m === 'notetaker' ? null : 'notetaker'))} />
            {menu === 'notetaker' ? <NotetakerMenu call={call} canModerate={people.canModerate} onDone={() => setMenu(null)} /> : null}
          </div>
          <div className="call-more">
            <button type="button" className="call-btn" aria-label="Call settings" aria-haspopup="dialog" aria-expanded={menu === 'settings'} title="Devices and settings" onClick={() => { setMenu((m) => (m === 'settings' ? null : 'settings')); void c.refreshDevices(); }} data-testid="call-settings-btn">
              <SlidersIcon />
            </button>
            {menu === 'settings' ? <Settings call={call} canEnd={canEnd} /> : null}
          </div>
          <button type="button" className="btn s call-chat" onClick={() => c.openChat()} disabled={!call.meeting.threadRootId} data-testid="call-chat">
            <ChatIcon />
            <span>Chat</span>
            {call.chatUnread > 0 ? <span className="call-unread" data-testid="call-chat-unread" aria-label={`${call.chatUnread} unread`}>{call.chatUnread > 99 ? '99+' : call.chatUnread}</span> : null}
          </button>
          <button type="button" className="btn s call-leave" onClick={() => void c.leave()} data-testid="call-leave">
            <LeaveIcon />
            <span>Leave</span>
          </button>
        </div>
      </div>
      {call.prefs.captions || visibleCaptions(call.captions.filter((l) => l.kind === 'answer'), now).length > 0 ? <Captions call={call} now={now} /> : null}
    </section>
  );
}
