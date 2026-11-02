import { TerminalText, type TerminalLimitsShape, type TerminalRecording, type TerminalStatusResponse } from '@manythreads/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { isApiError } from '../../../api/client';
import { isMockMode } from '../../../api/setup';
import { Alert } from '../../../components/ui';
import { endTerminal, fetchTerminalRecord, openTerminal, terminalSocketUrl, terminalStatus } from './api';
import { mockShellTransport } from './mock-transport';
import { KEY_EOF, KEY_INTERRUPT, asLine, chunkInput, endWords, fitSize, limitsLine, phaseWords, pushHistory, sessionRow, sizeWords, stepHistory, type Phase } from './model';
import { browserTerminalTransport, type TerminalTransport } from './transport';

/*
 * The Terminal view (PLAN P7-09; SPEC section 9): a text window into a throwaway test sandbox of one bot, for a workspace admin. Every class is prefixed `wt-`. It shows
 * what the shell prints as lines of plain text (colours and cursor moves are dropped, the same way the server records it) and takes a line at a time, because a line input is the one
 * thing that works the same with a keyboard, a phone and a screen reader. The page never decides who may open a terminal: the server does, on every call and on the socket's upgrade.
 */

export type TerminalTarget = { slug: string; botSlug: string; terminalId: string };

/** The transport of this page load: a pretend shell in the mock mode, the real socket otherwise. */
export const defaultTransportFor = (t: TerminalTarget): TerminalTransport => (isMockMode() ? mockShellTransport() : browserTerminalTransport(terminalSocketUrl(t.slug, t.botSlug, t.terminalId)));

const errorText = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'That did not work. Try again.');

export function TerminalView({ slug, botSlug, botName, onBack, transportFor = defaultTransportFor }: { slug: string; botSlug: string; botName: string; onBack: () => void; transportFor?: (t: TerminalTarget) => TerminalTransport }) {
  const [phase, setPhaseState] = useState<Phase>('checking');
  const phaseRef = useRef<Phase>('checking');
  const [status, setStatus] = useState<TerminalStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [limits, setLimits] = useState<TerminalLimitsShape | null>(null);
  const [revoked, setRevoked] = useState<number | null>(null);
  const [said, setSaid] = useState('');
  const [value, setValue] = useState('');
  const [text] = useState(() => new TerminalText());
  const [, redraw] = useState(0);
  const [record, setRecord] = useState<TerminalRecording | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const transport = useRef<TerminalTransport | null>(null);
  const terminalId = useRef<string | null>(null);
  const history = useRef<string[]>([]);
  const place = useRef(0);
  const draft = useRef('');
  const lastSize = useRef('');
  const screen = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const setPhase = useCallback((p: Phase, detail?: string): void => {
    phaseRef.current = p;
    setPhaseState(p);
    setSaid(phaseWords(p, detail));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await terminalStatus(slug, botSlug);
      setStatus(s);
      setError(null);
      if (phaseRef.current === 'checking' || phaseRef.current === 'unavailable' || phaseRef.current === 'ready') {
        if (s.available) setPhase('ready');
        else setPhase('unavailable', s.reason ?? undefined);
      }
    } catch (err) {
      setError(errorText(err));
      setPhase('unavailable', errorText(err));
    }
  }, [slug, botSlug, setPhase]);

  useEffect(() => {
    void load();
  }, [load]);

  // leaving the page closes the terminal: the server kills the shell when its socket closes
  useEffect(
    () => () => {
      const t = transport.current;
      transport.current = null;
      t?.close();
    },
    [],
  );

  // the newest output stays in sight
  useEffect(() => {
    const el = screen.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  // the command box takes focus once the terminal is open (it is switched off until then)
  useEffect(() => {
    if (phase === 'open') input.current?.focus();
  }, [phase]);

  const sendSize = useCallback((): void => {
    const el = screen.current;
    const t = transport.current;
    if (!el || !t || phaseRef.current !== 'open') return;
    const size = fitSize(el.clientWidth, el.clientHeight);
    const key = `${String(size.cols)}x${String(size.rows)}`;
    if (key === lastSize.current) return;
    lastSize.current = key;
    t.send({ t: 'size', ...size });
  }, []);

  useEffect(() => {
    const el = screen.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(() => sendSize());
    watch.observe(el);
    return () => watch.disconnect();
  }, [phase, sendSize]);

  const start = async (): Promise<void> => {
    setError(null);
    setNote(null);
    setRecord(null);
    text.clear();
    lastSize.current = '';
    setPhase('starting');
    try {
      const { session } = await openTerminal(slug, botSlug);
      terminalId.current = session.id;
      const t = transportFor({ slug, botSlug, terminalId: session.id });
      transport.current = t;
      t.onFrame((f) => {
        if (transport.current !== t) return;
        if (f.t === 'ready') {
          setLimits(f.limits);
          setRevoked(f.credentialsRevoked);
          setPhase('open', 'The terminal is open. Type a command and press Enter.');
          window.setTimeout(sendSize, 0);
        } else if (f.t === 'out') {
          text.feed(f.d);
          text.take();
          redraw((n) => n + 1);
        } else {
          const words = endWords(f.reason, f.message);
          setNote(words);
          setPhase('ended', words);
          transport.current = null;
          void load();
          window.setTimeout(() => heading.current?.focus(), 0);
        }
      });
      t.onClose((info) => {
        if (transport.current !== t) return;
        transport.current = null;
        if (phaseRef.current === 'starting') {
          setError('The terminal could not be connected. Try again.');
          setPhase('failed', 'The terminal could not be connected.');
        } else if (phaseRef.current === 'open') {
          const words = info.code === 1000 ? 'The terminal is closed.' : 'The connection was lost, so the terminal was closed.';
          setNote(words);
          setPhase('ended', words);
        }
        void load();
      });
    } catch (err) {
      const words = errorText(err);
      setError(words);
      setPhase('failed', words);
    }
  };

  const type = (data: string): void => {
    const t = transport.current;
    if (!t || phaseRef.current !== 'open') return;
    for (const d of chunkInput(data)) t.send({ t: 'in', d });
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (phaseRef.current !== 'open') return;
    history.current = pushHistory(history.current, value);
    place.current = history.current.length;
    draft.current = '';
    type(asLine(value));
    setValue('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (place.current === history.current.length) draft.current = value;
      const to = stepHistory(history.current, place.current, e.key, draft.current);
      place.current = to.index;
      setValue(to.text);
      return;
    }
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const el = e.currentTarget;
      const selected = (el.selectionEnd ?? 0) > (el.selectionStart ?? 0);
      // Ctrl+C with nothing selected stops what is running; with a selection it copies, as everywhere
      if (e.key.toLowerCase() === 'c' && !selected) {
        e.preventDefault();
        type(KEY_INTERRUPT);
      } else if (e.key.toLowerCase() === 'd' && value === '') {
        e.preventDefault();
        type(KEY_EOF);
      }
    }
  };

  const end = async (): Promise<void> => {
    const id = terminalId.current;
    const t = transport.current;
    if (!id) return;
    try {
      await endTerminal(slug, botSlug, id);
    } catch (err) {
      if (!(isApiError(err) && err.status === 409)) setError(errorText(err));
    }
    transport.current = null;
    t?.close();
    const words = endWords('ended_by_admin');
    setNote(words);
    setPhase('ended', words);
    void load();
    window.setTimeout(() => heading.current?.focus(), 0);
  };

  const leave = (): void => {
    const t = transport.current;
    transport.current = null;
    t?.close();
    onBack();
  };

  const showRecord = async (id: string): Promise<void> => {
    setRecordError(null);
    try {
      const { session } = await fetchTerminalRecord(slug, botSlug, id);
      setRecord(session);
    } catch (err) {
      setRecord(null);
      setRecordError(errorText(err));
    }
  };

  const live = phase === 'open';
  const showScreen = phase === 'open' || phase === 'ended' || phase === 'starting';
  const lines = text.lines;

  return (
    <section className="wt-screen" data-testid="terminal-view" data-phase={phase} aria-labelledby="wt-h">
      <h3 className="wt-h" id="wt-h" tabIndex={-1} ref={heading}>Terminal · {botName}</h3>
      <p className="wt-sr" role="status" aria-live="polite" data-testid="terminal-announce">{said}</p>

      <div className="wt-about" data-testid="terminal-about">
        <p className="wt-lead">A terminal is a text window where you type commands. This one opens inside a throwaway test sandbox for {botName}, to see how it behaves while you debug.</p>
        <ul className="wt-list">
          <li>The sandbox is a new, empty folder. It is wiped when you close the terminal.</li>
          <li>The shell runs as an ordinary user with no admin rights, and has no network: it cannot reach the internet, other servers or your team’s data.</li>
          <li>It only ever uses a test run, never a real one. A real run is refused.</li>
          <li>The keys made for the test are switched off before the window opens, so the shell holds none.</li>
          <li>Everything it prints is recorded with your name and the time. Secrets are masked and the record has a size limit.</li>
          <li>{limits ? limitsLine(limits) : status ? limitsLine(status.limits) : 'It closes by itself when nothing is typed for a while.'} Leaving this page closes it.</li>
        </ul>
      </div>

      {error ? <Alert>{error}</Alert> : null}

      {phase === 'checking' ? <p className="wt-hint" aria-busy="true">Checking…</p> : null}
      {phase === 'unavailable' ? <p className="wt-hint" data-testid="terminal-off">{status?.reason ?? 'A terminal cannot be opened here.'}</p> : null}

      {phase === 'ready' || phase === 'failed' || phase === 'ended' ? (
        <div className="wt-row">
          <button type="button" className="btn" data-testid="terminal-open" onClick={() => void start()}>{phase === 'ended' ? 'Open another terminal' : 'Open a terminal'}</button>
          <button type="button" className="btn s" data-testid="terminal-back" onClick={leave}>Back to the Workshop</button>
        </div>
      ) : null}
      {phase === 'unavailable' ? (
        <div className="wt-row">
          <button type="button" className="btn s" data-testid="terminal-back" onClick={leave}>Back to the Workshop</button>
        </div>
      ) : null}

      {showScreen ? (
        <>
          {revoked !== null && phase !== 'starting' ? <p className="wt-hint" data-testid="terminal-revoked">{revoked === 0 ? 'No keys were made for this test.' : `${String(revoked)} ${revoked === 1 ? 'key' : 'keys'} made for this test ${revoked === 1 ? 'was' : 'were'} switched off before it opened.`}</p> : null}
          <div className="wt-box" ref={screen} role="log" aria-label="Terminal output" tabIndex={0} data-testid="terminal-screen">
            <pre className="wt-text">{`${lines.join('\n')}${lines.length > 0 ? '\n' : ''}${text.current}`}</pre>
          </div>
          {phase === 'starting' ? <p className="wt-working" role="status"><span className="wt-spin" aria-hidden="true" />Opening…</p> : null}
          {phase === 'ended' && note ? <p className="wt-ended" data-testid="terminal-ended">{note}</p> : null}

          <form className="wt-form" onSubmit={submit} aria-label="Send a command" data-testid="terminal-form">
            <label className="wt-label" htmlFor="wt-in">Command</label>
            <div className="wt-line">
              <input
                id="wt-in"
                ref={input}
                className="wt-input"
                data-testid="terminal-input"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={value}
                disabled={!live}
                placeholder={live ? 'Type a command, then press Enter' : 'The terminal is not open'}
                onChange={(e) => {
                  setValue(e.target.value);
                  place.current = history.current.length;
                }}
                onKeyDown={onKey}
              />
              <button type="submit" className="btn" disabled={!live} data-testid="terminal-send">Send</button>
            </div>
            <div className="wt-row">
              <button type="button" className="btn s" disabled={!live} data-testid="terminal-interrupt" onClick={() => type(KEY_INTERRUPT)}>Stop the running command (Ctrl+C)</button>
              <button type="button" className="btn s" disabled={!live} data-testid="terminal-end" onClick={() => void end()}>End the terminal</button>
              {live ? <button type="button" className="btn s" data-testid="terminal-back" onClick={leave}>Close and go back</button> : null}
            </div>
            <p className="wt-hint">Up and down arrows bring back what you typed before. Ctrl+C stops a running command; Ctrl+D with an empty line ends the shell.</p>
          </form>
        </>
      ) : null}

      {status && status.sessions.length > 0 ? (
        <section className="wt-earlier" aria-labelledby="wt-earlier-h" data-testid="terminal-earlier">
          <h4 className="wt-h" id="wt-earlier-h">Earlier terminals for this bot</h4>
          <ul className="wt-rows">
            {status.sessions.slice(0, 10).map((s) => {
              const row = sessionRow(s);
              return (
                <li key={s.id} className="wt-erow">
                  <span className="wt-etitle">{row.title}</span>
                  <span className="wt-emeta">{row.meta} {sizeWords(s.bytesOut)} printed.</span>
                  <button type="button" className="btn s" data-testid={`terminal-record-${s.id}`} onClick={() => void showRecord(s.id)}>Show the record</button>
                </li>
              );
            })}
          </ul>
          {recordError ? <Alert>{recordError}</Alert> : null}
          {record ? (
            <div className="wt-record" data-testid="terminal-record">
              <p className="wt-hint">What the shell printed in that terminal{record.transcriptTruncated ? ' (cut at the size limit)' : ''}, with secrets masked.</p>
              <pre className="wt-text wt-recordtext" tabIndex={0} aria-label="Recorded terminal output">{record.transcript === '' ? '(nothing was printed)' : record.transcript}</pre>
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
