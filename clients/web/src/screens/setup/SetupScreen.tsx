import type { SetupSession } from '@manythreads/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useSession } from '../../app/session';
import { isApiError } from '../../api/client';
import { fetchTemplates } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { Alert } from '../../components/ui';
import { useHeaderTopic } from '../../shell/topic';
import { useProposalPerms } from '../proposals/store';
import { answerSetup, cancelSetup, fetchSetup, retrySetup, startSetup } from './api';
import { announcement, answersFrom, examplesFrom, FOCUS_ID, pollDelay, stepOf, stopsPolling, workingLine, type Draft } from './model';
import { BriefForm, Feasibility, InventoryPanel, Questions } from './parts';
import { ProposalStep } from './Proposal';
import { BackIcon } from '../../shell/icons';

/*
 * "Add a bot" (PLAN P7-04, mockup section `setup`): a person writes what the bot should do, a helper looks at what the team has and grades each need, asks every open question in one
 * list, and proposes the bot as a diff. Nothing is created until a person approves. The conversation is the person's own and runs on the server: the screen starts it and reads it again
 * until the helper has something to show. The session id is kept in the address (`?s=`), so reloading the page or coming back later picks the conversation up where it was.
 *
 * Not built yet (P7-05, the Workshop tab): a list of earlier setup conversations on the bot's page, and replaying a bot against past work.
 */

const errorText = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'That did not work. Try again.');

/** Reads the conversation `id` now and again while the helper is working. */
function useSetupSession(
  slug: string,
  id: string | null,
): { session: SetupSession | null; error: string | null; fatal: boolean; set: (s: SetupSession | null) => void; refresh: () => void } {
  const [session, set] = useState<SetupSession | null>(null);
  const [round, setRound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState(false);
  const attempts = useRef(0);
  useEffect(() => {
    setFatal(false);
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
      // a tab nobody looks at does not poll: it reads again when it comes back (below)
      if (typeof document !== 'undefined' && document.hidden) {
        later(attempts.current);
        return;
      }
      try {
        const { session: next } = await fetchSetup(slug, id);
        if (!live) return;
        setError(null);
        set(next);
        if (next.status === 'working') later(attempts.current);
      } catch (err) {
        if (!live) return;
        setError(errorText(err));
        // a conversation that is gone, not the person's, malformed, or whose sign-in ended will not come back: say so once, stop, and offer a fresh start
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
  }, [slug, id, round]);
  return { session, error, fatal, set, refresh: () => setRound((r) => r + 1) };
}

export function SetupScreen() {
  const { slug } = useProposalPerms();
  const [params, setParams] = useSearchParams();
  const id = params.get('s');
  const { session, error: readError, fatal, set, refresh } = useSetupSession(slug, id);
  const guest = useSession().role === 'guest';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  useHeaderTopic('Add a bot');
  // the bots of the team templates, offered as starting points for the brief; if they cannot be loaded the box simply has no examples
  const templates = useQuery('setup-examples', fetchTemplates);
  const templateList = templates.status === 'ok' ? templates.data.templates : null;
  const examples = useMemo(() => (templateList ? examplesFrom(templateList) : []), [templateList]);
  // while an earlier conversation is being fetched there is nothing to show yet: not the empty brief box
  const step = id === null ? 'brief' : session === null ? 'loading' : stepOf(session);

  // when the page changes under the person, keyboard focus goes to the new region's heading and a screen reader is told (not on the first paint of the page)
  const lastStep = useRef(step);
  useEffect(() => {
    if (lastStep.current === step) return;
    lastStep.current = step;
    const target = step === 'loading' || step === 'brief' ? undefined : FOCUS_ID[step];
    if (target) document.getElementById(target)?.focus();
  }, [step]);
  const said = step === 'loading' || step === 'brief' ? '' : announcement(step, session);

  // a new round of questions starts with empty answers
  const questionKey = session?.questions.map((q) => q.id).join(',') ?? '';
  useEffect(() => setDraft({}), [questionKey]);

  const begin = useCallback(
    async (brief: string, name: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const { session: created } = await startSetup(slug, brief, name || undefined);
        set(created);
        setParams({ s: created.id }, { replace: true });
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(false);
      }
    },
    [slug, set, setParams],
  );

  const send = async (): Promise<void> => {
    if (!session) return;
    const answers = answersFrom(session.questions, draft);
    if (answers === null) return;
    setBusy(true);
    setError(null);
    try {
      const { session: next } = await answerSetup(slug, session.id, answers);
      set(next);
      refresh(); // the helper is working again: read it until it has something to show
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { session: next } = await cancelSetup(slug, session.id);
      set(next);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // the last round again, from the answers already given: the conversation is kept, so nothing is asked twice
  const retry = async (): Promise<void> => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { session: next } = await retrySetup(slug, session.id);
      set(next);
      refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const startOver = (): void => {
    set(null);
    setDraft({});
    setError(null);
    setParams({}, { replace: true });
  };

  if (guest) {
    return (
      <div className="su-screen" data-testid="setup-screen">
        <p className="su-back"><Link to={`/t/${slug}/bots`}><BackIcon size={12} /> All bots</Link></p>
        <h2 className="su-title">Add a bot</h2>
        <p className="su-summary" data-testid="setup-guest">Guests can't add bots. Ask a member of the team to add one.</p>
      </div>
    );
  }

  return (
    <div className="su-screen" data-testid="setup-screen">
      <p className="su-back"><Link to={`/t/${slug}/bots`}><BackIcon size={12} /> All bots</Link></p>
      <div className="su-head">
        <h2 className="su-title">Add a bot</h2>
        <p className="su-sub">Describe what a bot should do. It finds out what this team has, checks the brief can be done, asks for what is missing and drafts the configuration. A person approves it.</p>
      </div>

      <p className="su-sr" role="status" aria-live="polite" data-testid="setup-announce">{said}</p>

      {step === 'brief' ? <BriefForm slug={slug} busy={busy} error={error ?? readError} examples={examples} onStart={(b, n) => void begin(b, n)} /> : null}

      {session && step !== 'brief' && step !== 'loading' ? (
        <div className="su-stack">
          <section className="su-card su-thread" aria-label="Your brief" data-testid="setup-thread">
            <p className="su-who">You asked{session.name ? ` for ${session.name}` : ''}</p>
            <p className="su-brief-text" data-vt-mask>{session.brief}</p>
          </section>

          {step === 'working' ? (
            <section className="su-card" data-testid="setup-working" data-landmark="setup-working">
              <h3 className="su-h" id="su-work-h" tabIndex={-1}>Working on it</h3>
              <p className="su-working"><span className="su-spin" aria-hidden="true" />{workingLine(session)}</p>
              <div className="su-actions">
                <button type="button" className="btn" disabled={busy} data-testid="setup-cancel" onClick={() => void stop()}>Stop</button>
              </div>
            </section>
          ) : null}

          {session.inventory ? <InventoryPanel inv={session.inventory} /> : null}
          <Feasibility requirements={session.requirements} />

          {step === 'asking' ? (
            <>
              {session.message ? <p className="su-summary" data-testid="setup-summary">{session.message}</p> : null}
              <Questions
                questions={session.questions}
                draft={draft}
                busy={busy}
                error={error}
                onChange={(qid, text) => setDraft((d) => ({ ...d, [qid]: text }))}
                onSend={() => void send()}
              />
              <div className="su-actions">
                <button type="button" className="btn" disabled={busy} data-testid="setup-cancel" onClick={() => void stop()}>Stop and start over</button>
              </div>
            </>
          ) : null}

          {step === 'proposed' ? <ProposalStep slug={slug} session={session} onDone={() => undefined} /> : null}

          {step === 'failed' || step === 'cancelled' ? (
            <section className="su-card" data-testid={`setup-${step}`}>
              <h3 className="su-h" id="su-end-h" tabIndex={-1}>{step === 'failed' ? 'The helper could not finish' : 'Stopped'}</h3>
              <p className="su-summary" role={step === 'failed' ? 'alert' : undefined}>
                {step === 'failed' ? (session.message ?? 'It did not finish. Try again, or add the bot by hand.') : 'Nothing was proposed and nothing was changed.'}
              </p>
              <div className="su-actions">
                {step === 'failed' ? (
                  <button type="button" className="btn primary" disabled={busy} data-testid="setup-retry" onClick={() => void retry()}>
                    {busy ? 'Trying again…' : 'Try again'}
                  </button>
                ) : null}
                <button type="button" className={step === 'failed' ? 'btn' : 'btn primary'} data-testid="setup-again" onClick={startOver}>Start again</button>
                <Link className="btn" to={`/t/${slug}/files?path=bots`}>Configure by hand instead</Link>
              </div>
            </section>
          ) : null}
          {error && step !== 'asking' ? <Alert>{error}</Alert> : null}
        </div>
      ) : null}

      {id !== null && session === null ? (
        fatal ? (
          <section className="su-card" data-testid="setup-gone">
            <h3 className="su-h" id="su-end-h" tabIndex={-1}>This conversation can't be opened</h3>
            <Alert>{readError ?? 'It may have been removed, or you may need to sign in again.'}</Alert>
            <div className="su-actions">
              <button type="button" className="btn primary" data-testid="setup-again" onClick={startOver}>Start again</button>
              <Link className="btn" to={`/t/${slug}/bots`}>Back to bots</Link>
            </div>
          </section>
        ) : readError ? (
          <Alert>{readError}</Alert>
        ) : (
          <p className="su-working" role="status"><span className="su-spin" aria-hidden="true" />Loading…</p>
        )
      ) : null}
    </div>
  );
}
