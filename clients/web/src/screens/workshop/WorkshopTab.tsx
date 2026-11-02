import type { WorkshopMode, WorkshopSession, WorkshopSessionId } from '@manythreads/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { isAdmin, useSession } from '../../app/session';
import { Alert } from '../../components/ui';
import { useShell } from '../../shell/context';
import { pollDelay, stopsPolling } from '../setup/model';
import { endWorkshop, fetchWorkshop, listWorkshop, sayInWorkshop, startWorkshop } from './api';
import { announcement, asRule, messagesLeft, modeInfo, modeOf, usageLine } from './model';
import { Compose, EarlierList, ModeTabs, Transcript, ViewTabs, viewPanelProps } from './parts';
import { ReassessmentNotices, ReplayPanel } from './Replay';
import { TerminalView } from './terminal/TerminalView';

/*
 * The Workshop tab of a bot (PLAN P7-05, P7-06; mockup sections `workshop` and `setup`), at `/t/:team/bots/:botSlug/chat?view=workshop`.
 *   Build     ask for a change; it becomes a proposal that waits for a person; a correction becomes a lesson, a test case and, when it repeats, a rule.
 *   Rehearse  talk to the bot as it really is; anything that would change something is held back and marked "not really done".
 *   Live      ask about what the bot really did, from the runs you may see.
 * A conversation is the person's own and the answer is written in the background, so the tab sends a message and then reads the conversation again until it is ready. The address keeps
 * the mode (`mode=`) and the conversation (`ws=`), so reloading comes back to the same place.
 * A workspace admin also sees "Open a terminal" (PLAN P7-09): `terminal=1` swaps the conversations for the Terminal view of a throwaway test sandbox. Anyone else who opens that address is told
 * it is for admins; the server refuses them as well.
 */

const errorText = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'That did not work. Try again.');

/** Reads the conversation `id` now and again while it is being answered. */
function useWorkshopSession(slug: string, botSlug: string, id: string | null) {
  const [session, set] = useState<WorkshopSession | null>(null);
  const [round, setRound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState(false);
  const attempts = useRef(0);
  useEffect(() => {
    setFatal(false);
    setError(null);
    if (id === null) {
      set(null);
      return undefined;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    attempts.current = 0;
    const later = (attempt: number): void => {
      timer = setTimeout(() => void tick(), pollDelay(attempt));
      attempts.current += 1;
    };
    const tick = async (): Promise<void> => {
      // a tab nobody looks at does not poll: it reads again when it comes back
      if (typeof document !== 'undefined' && document.hidden) {
        later(attempts.current);
        return;
      }
      try {
        const { session: next } = await fetchWorkshop(slug, botSlug, id);
        if (!live) return;
        setError(null);
        set(next);
        if (next.status === 'working') later(attempts.current);
      } catch (err) {
        if (!live) return;
        setError(errorText(err));
        if (isApiError(err) && stopsPolling(err.status)) {
          setFatal(true);
          return;
        }
        later(Math.max(attempts.current, 12));
      }
    };
    const back = (): void => {
      if (document.hidden) return;
      if (timer) clearTimeout(timer);
      void tick();
    };
    document.addEventListener('visibilitychange', back);
    void tick();
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', back);
      if (timer) clearTimeout(timer);
    };
  }, [slug, botSlug, id, round]);
  return { session, error, fatal, set, refresh: () => setRound((r) => r + 1) };
}

type About = { sessionId: WorkshopSessionId; entryId: string; excerpt: string };

/** Rehearse is for a team lead or a workspace admin, and the platform checks it again on every request; the tab only says so up front. While the team is not known yet nothing is switched off. */
export const REHEARSE_LEADS_ONLY = 'Only a team lead or an admin can rehearse a bot.';

export function WorkshopTab({ slug, botSlug, botName, onView }: { slug: string; botSlug: string; botName: string; onView: (v: 'chat' | 'workshop') => void }) {
  const [params, setParams] = useSearchParams();
  const { team } = useShell();
  const session0 = useSession();
  const admin = isAdmin(session0);
  const terminal = params.get('terminal') === '1';
  const canRehearse = team === null || team === undefined || isAdmin(session0) || team.myRole === 'lead';
  const asked = modeOf(params.get('mode'));
  // a person who may not rehearse lands on Build when the address asks for Rehearse: the tab stays greyed, and none of Rehearse's own words show
  const mode = asked === 'rehearse' && !canRehearse ? 'build' : asked;
  const id = params.get('ws');
  const [listTick, setListTick] = useState(0);
  const list = useQuery(`workshop-list:${slug}:${botSlug}:${String(listTick)}`, () => listWorkshop(slug, botSlug));
  const { session, error: readError, fatal, set, refresh } = useWorkshopSession(slug, botSlug, id);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [about, setAbout] = useState<About | null>(null);
  const [said, setSaid] = useState('');
  const info = modeInfo(mode);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (next: { mode?: WorkshopMode; ws?: string | null }): void => {
      const q = new URLSearchParams(params);
      q.set('view', 'workshop');
      q.delete('terminal');
      if (next.mode !== undefined) q.set('mode', next.mode);
      if (next.ws !== undefined) {
        if (next.ws === null) q.delete('ws');
        else q.set('ws', next.ws);
      }
      setParams(q, { replace: false });
    },
    [params, setParams],
  );

  // a conversation that belongs to another mode than the one in the address shows under its own mode
  useEffect(() => {
    if (session && id !== null && session.id === id && session.mode !== mode) go({ mode: session.mode });
  }, [session, id, mode, go]);

  // the screen reader hears when an answer arrives, and focus goes to the conversation's heading when one is opened
  const prev = useRef<WorkshopSession | null>(null);
  useEffect(() => {
    setSaid(announcement(prev.current, session));
    if (session && prev.current?.status === 'working' && session.status !== 'working') setListTick((t) => t + 1);
    prev.current = session;
  }, [session]);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (session && opened.current !== session.id) {
      opened.current = session.id;
      headingRef.current?.focus();
    }
  }, [session]);

  const sessions = (list.status === 'ok' ? list.data.sessions : []).filter((s) => s.mode === mode);
  const working = session?.status === 'working';
  const over = session !== null && (session.status === 'ended' || session.status === 'failed' || session.status === 'cancelled');
  const full = session !== null && messagesLeft(session) === 0;
  const blocked = mode === 'rehearse' && !canRehearse ? REHEARSE_LEADS_ONLY : working ? 'The answer is on its way. You can write the next message when it arrives.' : over ? 'This conversation is over. Start a new one.' : full ? 'This conversation is full. Start a new one.' : null;

  const send = async (body: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let target = session;
      if (target === null || target.mode !== mode) {
        const made = await startWorkshop(slug, botSlug, mode);
        target = made.session;
        opened.current = target.id; // the person is typing here: focus stays in the message box
        go({ ws: target.id });
      }
      const { session: next } = await sayInWorkshop(slug, botSlug, target.id, body, about && mode === 'build' ? { sessionId: about.sessionId, entryId: about.entryId } : undefined);
      set(next);
      setText('');
      setAbout(null);
      refresh();
      setListTick((t) => t + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const end = async (): Promise<void> => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { session: next } = await endWorkshop(slug, botSlug, session.id);
      set(next);
      setListTick((t) => t + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const correct = (entryId: string, excerpt: string): void => {
    if (!session) return;
    setAbout({ sessionId: session.id, entryId, excerpt });
    setText('');
    // the correction is written in a Build conversation: a new one, so the rehearsal stays as it was
    go({ mode: 'build', ws: null });
    window.setTimeout(() => textRef.current?.querySelector('textarea')?.focus(), 50);
  };

  const panelId = 'ws-panel';
  return (
    <div className="ws-screen" data-testid="workshop-tab" data-mode={mode} {...viewPanelProps('workshop')}>
      <div className="ws-head">
        <p className="ws-back"><Link to={`/t/${slug}/bots`}>← All bots</Link></p>
        <h2 className="ws-title">{botName} <span className="ws-sub">· Workshop</span></h2>
        <ViewTabs view="workshop" onChange={onView} />
        {admin && !terminal ? (
          <button type="button" className="btn s" data-testid="ws-terminal-open" onClick={() => { const q = new URLSearchParams(params); q.set('view', 'workshop'); q.set('terminal', '1'); setParams(q, { replace: false }); }}>
            Open a terminal
          </button>
        ) : null}
      </div>

      <p className="ws-sr" role="status" aria-live="polite" data-testid="ws-announce">{said}</p>

      {terminal && !admin ? (
        <p className="ws-hint" role="status" data-testid="ws-terminal-denied">The terminal is for workspace admins only.</p>
      ) : null}
      {terminal && admin ? (
        <TerminalView slug={slug} botSlug={botSlug} botName={botName} onBack={() => go({})} />
      ) : null}

      {terminal ? null : <ModeTabs mode={mode} panelId={panelId} rehearseReason={canRehearse ? undefined : REHEARSE_LEADS_ONLY} onChange={(m) => { setError(null); go({ mode: m, ws: null }); }} />}

      {terminal ? null : <div className="ws-body" id={panelId} role="tabpanel" aria-label={`${info.label} conversations`}>
        <p className="ws-lead" data-testid="ws-lead">{info.lead}</p>
        <p className="ws-hint">{info.hint}</p>

        {/* what changed under this bot (a knowledge base, a runner, its test score) and, in Live, the free replay of its earlier decisions (P7-07) */}
        <ReassessmentNotices slug={slug} botSlug={botSlug} canManage={canRehearse} compact={mode !== 'live'} onOpen={() => { setError(null); go({ mode: 'live', ws: null }); }} />
        {mode === 'live' ? (
          <ReplayPanel
            slug={slug}
            botSlug={botSlug}
            canManage={canRehearse}
            onStarted={(started) => {
              setListTick((t) => t + 1);
              go({ mode: 'rehearse', ws: started.id });
            }}
          />
        ) : null}

        <div className="ws-grid">
          <aside className="ws-side" aria-label="Earlier conversations">
            <h3 className="ws-h">Earlier</h3>
            {list.status === 'loading' ? <p className="ws-hint" aria-busy="true">Loading…</p> : null}
            {list.status === 'error' ? <Alert>{list.error.message || 'Could not load your conversations.'}</Alert> : null}
            {list.status === 'ok' ? <EarlierList items={sessions} current={id} onOpen={(sid) => go({ ws: sid })} /> : null}
            <button type="button" className="btn s" data-testid="ws-new" disabled={id === null && !session} onClick={() => { setAbout(null); setError(null); go({ ws: null }); }}>
              {info.start}
            </button>
          </aside>

          <section className="ws-main" aria-labelledby="ws-conv-h">
            <h3 className="ws-h" id="ws-conv-h" tabIndex={-1} ref={headingRef}>{session ? session.title || 'Conversation' : 'New conversation'}</h3>

            {id !== null && session === null ? (
              fatal ? (
                <div data-testid="ws-gone">
                  <Alert>{readError ?? 'This conversation can not be opened.'}</Alert>
                  <button type="button" className="btn" onClick={() => go({ ws: null })}>Start a new one</button>
                </div>
              ) : readError ? (
                <Alert>{readError}</Alert>
              ) : (
                <p className="ws-working" role="status"><span className="ws-spin" aria-hidden="true" />Loading…</p>
              )
            ) : (
              <>
                {session ? (
                  <Transcript entries={session.entries} slug={slug} {...(session.mode === 'rehearse' && !over ? { onCorrect: correct } : {})}>
                    {working ? (
                      <li className="ws-working" data-testid="ws-working"><span className="ws-spin" aria-hidden="true" />Working on it…</li>
                    ) : null}
                  </Transcript>
                ) : (
                  <p className="ws-hint" data-testid="ws-empty">{mode === 'rehearse' ? `Write a first message and ${botName} answers it as it really would, with nothing sent.` : 'Write your first message below to start.'}</p>
                )}

                {session?.status === 'failed' ? (
                  <div data-testid="ws-failed">
                    <Alert>{session.message ?? 'It could not finish. Start a new conversation.'}</Alert>
                  </div>
                ) : null}
                {session?.status === 'ended' ? <p className="ws-hint" data-testid="ws-ended">This conversation has ended.</p> : null}
                {session && usageLine(session.usage) ? <p className="ws-usage" data-testid="ws-usage" data-label={session.usage.label}>{usageLine(session.usage)}</p> : null}

                <div ref={textRef}>
                  <Compose
                    mode={mode}
                    text={text}
                    onText={setText}
                    onSend={() => void send(text.trim())}
                    busy={busy}
                    blocked={blocked}
                    error={error}
                    canRule={mode === 'build'}
                    ruleDisabled={false}
                    onRule={() => void send(asRule(text))}
                    about={about && mode === 'build' ? about.excerpt : null}
                    onDropAbout={() => setAbout(null)}
                  />
                </div>

                {session && (session.status === 'ready' || working) ? (
                  <div className="ws-row">
                    <button type="button" className="btn s" disabled={busy} data-testid="ws-end" onClick={() => void end()}>End this conversation</button>
                    <span className="ws-hint">{messagesLeft(session)} messages left in this conversation.</span>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>}
    </div>
  );
}
