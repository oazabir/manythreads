import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type RefObject } from 'react';
import { useParams } from 'react-router';
import { GUEST_PAGE_PREFIX, type MeetingParticipant } from '@manythreads/shared';
import { AuthFrame } from '../components/frames';
import { ExpiredLinkPage, FullPageMessage } from '../components/states';
import { Alert, Field, Toggle } from '../components/ui';
import { CallStage } from '../meetings/CallStage';
import { engineLine } from '../meetings/consent';
import { MeetingClock, guestEngine } from '../meetings/engine';
import { CameraIcon, LeaveIcon, MicIcon } from '../meetings/icons';
import { loadAdapter } from '../meetings/media';
import { DEFAULT_PREFS } from '../meetings/prefs';
import { useDocumentTitle } from '../shell/usePageTitle';
import { realGuestApi } from './api';
import { GUEST_WORDS, GuestController, mustAsk, type GuestState } from './guestController';

/*
 * The page a guest link opens (P17-04): `/join/g/<token>`, outside the sign-in check and the app's frame, loaded only when opened. Someone outside the workspace
 * sees the call's title and the workspace's name (never the channel or who is in it), types a name, checks their microphone and camera, and asks to join. Once
 * the knock is in, the address loses its secret (`/join/g/`) and the page follows the guest's cookie. In the call: the tiles with names, mute, camera, leave.
 */

function useGuest(controller: GuestController): GuestState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

export function GuestJoinPage() {
  const { token } = useParams();
  const controller = useMemo(
    () =>
      new GuestController({
        api: realGuestApi,
        loadAdapter,
        now: () => Date.now(),
        setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
        clearInterval: (h) => globalThis.clearInterval(h as number),
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimeout: (h) => globalThis.clearTimeout(h as number),
        engine: { load: guestEngine, clock: (startedAt) => new MeetingClock(startedAt) },
        forgetAddress: () => {
          try {
            window.history.replaceState(null, '', GUEST_PAGE_PREFIX);
          } catch {
            /* an address that cannot be changed keeps the secret only in this tab */
          }
        },
      }),
    [],
  );
  const state = useGuest(controller);
  useEffect(() => {
    void controller.open(token && token !== '' ? token : null);
    return () => controller.dispose();
  }, [controller]); // eslint-disable-line react-hooks/exhaustive-deps
  // a hidden tab's timers are slowed by the browser: shown again, the page says at once that it is still there
  useEffect(() => {
    const onShow = (): void => {
      if (document.visibilityState === 'visible') void controller.shown();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [controller]);

  const p = state.phase;
  if (p.kind === 'loading') return <FullPageMessage title="Opening the call" busy />;
  if (p.kind === 'gone') return <ExpiredLinkPage kind="guest" />;
  if (p.kind === 'failed') {
    return (
      <FullPageMessage title="This call could not be opened" tone="alert" detail={p.message}>
        <button type="button" className="btn" onClick={() => controller.tryAgain()} data-testid="guest-retry">Try again</button>
      </FullPageMessage>
    );
  }
  if (p.kind === 'open') return <JoinForm controller={controller} state={state} />;
  if (p.kind === 'waiting') {
    return (
      <AuthFrame title={p.title}>
        <p className="auth-lede gst-wait" role="status" data-testid="guest-waiting">{GUEST_WORDS.waiting}</p>
        <div className="auth-actions">
          <button type="button" className="btn" onClick={() => void controller.leave()} data-testid="guest-cancel">Cancel</button>
        </div>
      </AuthFrame>
    );
  }
  if (p.kind === 'joining' || p.kind === 'in-call') return <GuestCall controller={controller} state={state} />;
  const words = GUEST_WORDS[p.kind];
  return (
    <AuthFrame title={p.title || 'Call'}>
      <p className="auth-lede" role="status" data-testid={`guest-${p.kind}`}>{words}</p>
      {p.kind === 'nobody' ? (
        <div className="auth-actions">
          <button type="button" className="btn primary" onClick={() => controller.tryAgain()} data-testid="guest-try-again">Try again</button>
        </div>
      ) : null}
    </AuthFrame>
  );
}

// ---- before the knock: the name and the device check --------------------------------------------------------------------------------------------------

type DeviceCheck = { level: number; inputs: { id: string; label: string }[]; problem: string | null };

/** Opens the microphone (and the camera when it is on) for the check only: a meter, a preview, the list of microphones. Everything is closed again on leaving. */
function useDeviceCheck(active: boolean, micOn: boolean, cameraOn: boolean, inputId: string | null, preview: RefObject<HTMLVideoElement | null>): DeviceCheck {
  const [level, setLevel] = useState(0);
  const [inputs, setInputs] = useState<{ id: string; label: string }[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!active || (!micOn && !cameraOn) || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setLevel(0);
      return;
    }
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let frame = 0;
    let stopped = false;
    const video = preview.current;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: micOn ? (inputId ? { deviceId: inputId } : true) : false, video: cameraOn });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setProblem(null);
        if (video) video.srcObject = cameraOn ? stream : null;
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        setInputs(devices.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })));
        if (micOn && typeof AudioContext !== 'undefined') {
          ctx = new AudioContext();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          ctx.createMediaStreamSource(stream).connect(analyser);
          const data = new Uint8Array(analyser.frequencyBinCount);
          const tick = (): void => {
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
            setLevel(Math.min(1, peak / 64));
            frame = requestAnimationFrame(tick);
          };
          tick();
        }
      } catch {
        if (!stopped) setProblem('Your browser did not allow the microphone or camera. You can still ask to join and turn them on later.');
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      if (video) video.srcObject = null;
    };
  }, [active, micOn, cameraOn, inputId, preview]);
  return { level, inputs, problem };
}

function JoinForm({ controller, state }: { controller: GuestController; state: GuestState }) {
  const p = state.phase;
  const peek = p.kind === 'open' ? p.peek : null;
  const preview = useRef<HTMLVideoElement>(null);
  const check = useDeviceCheck(peek !== null, state.micOn, state.cameraOn, state.inputId, preview);
  if (!peek) return null;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void controller.knock();
  };
  return (
    <AuthFrame title={`Join ${peek.title} · ${peek.workspaceName}`} lede={peek.kind === 'video' ? 'A video call.' : 'An audio call.'}>
      <form className="gst-form" onSubmit={submit} data-testid="guest-page" noValidate>
        {peek.transcribing ? <p className="gst-note" data-testid="guest-transcribing">{GUEST_WORDS.transcribed}</p> : null}
        {!peek.transcribing && peek.notetaker ? <p className="gst-note" data-testid="guest-notetaker">{GUEST_WORDS.notetaker}</p> : null}
        <Field
          label="Your name"
          value={state.name}
          maxLength={60}
          autoComplete="name"
          onChange={(e) => controller.setName(e.target.value)}
          error={state.error ?? undefined}
          data-testid="guest-name"
          data-autofocus
        />
        <fieldset className="gst-devices" data-testid="guest-devices">
          <legend className="gst-legend">Check your microphone and camera</legend>
          <div className="gst-preview" data-testid="guest-preview">
            {state.cameraOn ? <video ref={preview} autoPlay playsInline muted className="mirror" /> : <span className="gst-preview-off">Camera off</span>}
          </div>
          <div className="gst-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(check.level * 100)} data-testid="guest-meter">
            <span className="gst-meter-bar" style={{ width: `${Math.round(check.level * 100)}%` }} />
          </div>
          <div className="gst-toggles">
            <Toggle checked={state.micOn} onChange={(v) => controller.setMicOn(v)} label="Microphone" testId="guest-mic" />
            <span className="gst-toggle-name">Microphone</span>
            <Toggle checked={state.cameraOn} onChange={(v) => controller.setCameraOn(v)} label="Camera" testId="guest-camera" />
            <span className="gst-toggle-name">Camera</span>
          </div>
          {check.inputs.length > 1 ? (
            <label className="gst-picker">
              <span>Microphone</span>
              <select className="dlg-input" value={state.inputId ?? ''} onChange={(e) => controller.setInput(e.target.value || null)} data-testid="guest-input">
                <option value="">Default</option>
                {check.inputs.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
            </label>
          ) : null}
          {check.problem ? <p className="gst-note" role="status" data-testid="guest-device-problem">{check.problem}</p> : null}
        </fieldset>
        <div className="auth-actions">
          <button type="submit" className="btn primary gst-join" disabled={state.busy} data-testid="guest-join">{state.busy ? 'Asking…' : 'Ask to join'}</button>
        </div>
      </form>
    </AuthFrame>
  );
}

// ---- in the call -------------------------------------------------------------------------------------------------------------------------------------

/**
 * "Transcribe my voice?" (step 2), while the call is transcribed: the question until the guest answers, then one line saying what was chosen, with a button to change
 * it. Nothing at all while the call is not transcribed.
 */
function GuestTranscription({ controller, state }: { controller: GuestController; state: GuestState }) {
  if (state.phase.kind !== 'in-call' || state.transcription === 'off') return null;
  if (mustAsk(state)) {
    return (
      <section className="gst-consent" aria-labelledby="gst-consent-title" data-testid="guest-consent">
        <h2 id="gst-consent-title" className="gst-consent-title">{GUEST_WORDS.promptTitle}</h2>
        <p className="gst-consent-body">{GUEST_WORDS.promptBody(state.turnedOnBy)}</p>
        <div className="gst-consent-actions">
          <button type="button" className="btn primary s" disabled={state.answering} onClick={() => void controller.answer('yes')} data-testid="guest-consent-yes">{GUEST_WORDS.yes}</button>
          <button type="button" className="btn s" disabled={state.answering} onClick={() => void controller.answer('no')} data-testid="guest-consent-no">{GUEST_WORDS.no}</button>
        </div>
      </section>
    );
  }
  const yes = state.consent === 'yes';
  const line = yes ? engineLine(state.engine) : null;
  return (
    <p className="gst-transcribe" role="status" data-testid="guest-transcribe-state" data-consent={state.consent}>
      <span>{yes ? 'Your voice is being transcribed on this device.' : 'Your voice is not transcribed.'}</span>
      {line ? <span className="gst-transcribe-note">{line}</span> : null}
      <button type="button" className="btn s" disabled={state.answering} onClick={() => void controller.answer(yes ? 'no' : 'yes')} data-testid="guest-transcribe-change">
        {yes ? 'Stop transcribing me' : 'Transcribe my voice'}
      </button>
    </p>
  );
}

function GuestCall({ controller, state }: { controller: GuestController; state: GuestState }) {
  const title = state.phase.kind === 'in-call' || state.phase.kind === 'joining' ? state.phase.title : '';
  useDocumentTitle(title || 'Call');
  const joining = state.phase.kind === 'joining';
  // the stage draws names from `present`: here, everyone in the call by their media identity (people by actor id, guests as `guest:<id>`)
  const present = state.people.map((p) => ({ actorId: p.identity, displayName: p.displayName })) as unknown as MeetingParticipant[];
  return (
    <div className="gst-call" data-testid="app-frame">
      <main className="gst-call-main" data-landmark="content" data-testid="guest-call" data-phase={state.phase.kind}>
        <header className="gst-call-head">
          <h1 className="gst-call-title">{title}</h1>
          <span className="gst-call-state" role="status">{joining ? 'Joining…' : state.reconnecting ? 'Reconnecting…' : 'In the call'}</span>
        </header>
        <GuestTranscription controller={controller} state={state} />
        <CallStage call={{ videos: state.videos, speaking: state.speaking, prefs: DEFAULT_PREFS, present }} media={controller} />
        <ul className="gst-people" aria-label="People in the call" data-testid="guest-people">
          {state.people.map((p) => (
            <li key={p.identity} className={`gst-person ${state.speaking.has(p.identity) ? 'speaking' : ''}`} data-testid="guest-person">{p.displayName}</li>
          ))}
        </ul>
        {state.error ? <Alert>{state.error}</Alert> : null}
      </main>
      <nav className="gst-bar" aria-label="Call controls" data-testid="guest-bar">
        <button
          type="button"
          className={`call-btn ${state.micOn ? '' : 'on'}`}
          aria-pressed={!state.micOn}
          aria-label={state.micOn ? 'Mute' : 'Unmute'}
          title={state.micOn ? 'Mute' : 'Unmute'}
          disabled={joining}
          onClick={() => controller.setMicOn(!state.micOn)}
          data-testid="guest-mute"
        >
          <MicIcon off={!state.micOn} />
        </button>
        <button
          type="button"
          className={`call-btn ${state.cameraOn ? 'on' : ''}`}
          aria-pressed={state.cameraOn}
          aria-label={state.cameraOn ? 'Turn your camera off' : 'Turn your camera on'}
          title={state.cameraOn ? 'Turn your camera off' : 'Turn your camera on'}
          disabled={joining}
          onClick={() => controller.setCameraOn(!state.cameraOn)}
          data-testid="guest-camera-toggle"
        >
          <CameraIcon />
        </button>
        <button type="button" className="btn danger s gst-leave" onClick={() => void controller.leave()} data-testid="guest-leave">
          <LeaveIcon /> Leave
        </button>
      </nav>
    </div>
  );
}
