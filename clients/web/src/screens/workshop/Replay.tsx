import type { FullReplayEstimate, Reassessment, ReplayResult, WorkshopSession } from '@manythreads/shared';
import { useRef, useState } from 'react';
import { useQuery } from '../../app/useQuery';
import { Alert } from '../../components/ui';
import { askFullReplay, closeReassessment, fetchReplay, listReassessments } from './replay-api';
import { DAY_CHOICES, KIND_WORDS, REASON_WORDS, VERDICT_WORDS, changeLine, confirmLabel, estimateLines, kindLine, noticesLine, summaryLine } from './replay-model';

/*
 * Replay and "check this again" (PLAN P7-07; mockup section `workshop`, the Guard tab's "Replay guard and gate decisions"). Classes are prefixed `ws-` (styles/workshop.css).
 *   The replay is free: no model is called and nothing is done, it asks today's rules the same questions about what the bot decided before. The result is read out as one sentence
 *   when it arrives, and the list below it is plain text (a decision that changes is named by words, never by colour alone).
 *   A full replay (the bot answering the same message again) shows its cost first and runs only after the person confirms it; it opens as a rehearsal.
 */

const errorText = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'That did not work. Try again.');
const when = (iso: string): string => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function ReplayPanel({ slug, botSlug, canManage, onStarted }: { slug: string; botSlug: string; canManage: boolean; onStarted: (session: WorkshopSession) => void }) {
  const [days, setDays] = useState<number>(30);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ runId: string; at: string; estimate: FullReplayEstimate } | null>(null);
  const [said, setSaid] = useState('');
  const resultRef = useRef<HTMLHeadingElement>(null);
  const estimateRef = useRef<HTMLHeadingElement>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setAsking(null);
    try {
      const { replay } = await fetchReplay(slug, botSlug, days);
      setResult(replay);
      setSaid(summaryLine(replay));
      window.setTimeout(() => resultRef.current?.focus(), 0);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const showCost = async (runId: string, at: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await askFullReplay(slug, botSlug, runId);
      if (answer.status === 'needs_confirmation') {
        setAsking({ runId, at, estimate: answer.estimate });
        window.setTimeout(() => estimateRef.current?.focus(), 0);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (busy || !asking) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await askFullReplay(slug, botSlug, asking.runId, { tokens: asking.estimate.tokens, token: asking.estimate.confirmToken });
      if (answer.status === 'started') {
        setAsking(null);
        onStarted(answer.session);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = (): void => {
    const runId = asking?.runId;
    setAsking(null);
    window.setTimeout(() => (runId ? triggerRefs.current.get(runId) : undefined)?.focus(), 0);
  };

  return (
    <section className="ws-replay" aria-labelledby="ws-replay-h" data-testid="ws-replay">
      <h3 className="ws-h" id="ws-replay-h">Replay guard and gate decisions</h3>
      <p className="ws-hint">
        Free and repeatable. This asks today’s rules the same questions about what the bot decided before, and shows which answers would change. No model is called and nothing is done or
        written. A full replay, where the bot answers a message again, is a separate step that shows its cost first.
      </p>
      <div className="ws-row">
        <label className="ws-days">
          <span>Look back</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={busy} data-testid="ws-replay-days">
            {DAY_CHOICES.map((d) => <option key={d} value={d}>{`${String(d)} days`}</option>)}
          </select>
        </label>
        <button type="button" className="btn" aria-disabled={busy || undefined} data-testid="ws-replay-run" onClick={() => void run()}>
          {busy && !asking ? 'Replaying…' : `Replay decisions · last ${String(days)} days`}
        </button>
      </div>

      <p className="ws-sr" role="status" aria-live="polite" data-testid="ws-replay-announce">{said}</p>
      {error ? <Alert>{error}</Alert> : null}

      {result ? (
        <div className="ws-replay-result" data-testid="ws-replay-result">
          <h4 className="ws-h2" tabIndex={-1} ref={resultRef}>Result</h4>
          <p className="ws-summary" data-testid="ws-replay-summary">{summaryLine(result)}</p>
          {result.decisionsCapped ? (
            <p className="ws-hint" role="note" data-testid="ws-replay-capped">Not everything was checked. This window holds more than one replay reads, so some decisions are left out or listed as not checked. Choose a shorter window to see the rest.</p>
          ) : null}
          {result.counts.total > 0 ? (
            <dl className="ws-kinds" data-testid="ws-replay-kinds">
              {(['gate', 'guard', 'tool'] as const).map((k) => (
                <div key={k} className="ws-kind">
                  <dt>{KIND_WORDS[k]}</dt>
                  <dd>{kindLine(result.byKind[k])}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {result.changes.length > 0 ? (
            <ul className="ws-changes" aria-label="Decisions that would change or cannot be checked again" data-testid="ws-replay-changes">
              {result.changes.map((c, i) => (
                <li key={`${c.runId}-${String(i)}`} className={`ws-change ws-v-${c.verdict}`} data-testid="ws-replay-change" data-verdict={c.verdict}>
                  <p className="ws-change-head">
                    <span className="ws-verdict">{VERDICT_WORDS[c.verdict]}</span>
                    <span className="ws-change-what">{KIND_WORDS[c.kind]}: {c.what}</span>
                    <span className="ws-when">{when(c.at)}</span>
                  </p>
                  <p className="ws-change-line">{changeLine(c.recorded, c.now)}</p>
                  <p className="ws-change-why">{c.explanation}</p>
                </li>
              ))}
            </ul>
          ) : null}
          {result.changesCapped ? <p className="ws-hint">Only the newest {result.changes.length} are listed.</p> : null}

          <ul className="ws-notes" aria-label="What a replay cannot do" data-testid="ws-replay-notes">
            {result.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>

          <div className="ws-full" data-testid="ws-full">
            <h4 className="ws-h2">Ask the bot again</h4>
            {!canManage ? (
              <p className="ws-hint" data-testid="ws-full-lead-only">Only a team lead or an admin can ask the bot to answer an earlier message again.</p>
            ) : result.fullReplayable.length === 0 ? (
              <p className="ws-hint" data-testid="ws-full-none">No run in this period kept the message it read, so none can be asked again.</p>
            ) : (
              <ul className="ws-runs" aria-label="Runs that can be replayed in full">
                {result.fullReplayable.map((r) => (
                  <li key={r.runId} className="ws-run">
                    <span>Run of {when(r.at)}</span>
                    <button
                      type="button"
                      className="btn s"
                      aria-disabled={busy || undefined}
                      data-testid="ws-full-ask"
                      ref={(el) => {
                        if (el) triggerRefs.current.set(r.runId, el);
                        else triggerRefs.current.delete(r.runId);
                      }}
                      onClick={() => void showCost(r.runId, r.at)}
                    >
                      See what a full replay costs
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {asking ? (
              <div className="ws-estimate" role="group" aria-labelledby="ws-estimate-h" data-testid="ws-estimate">
                <h5 className="ws-h2" id="ws-estimate-h" tabIndex={-1} ref={estimateRef}>Cost of replaying the run of {when(asking.at)}</h5>
                {estimateLines(asking.estimate).map((l) => <p key={l} className="ws-hint">{l}</p>)}
                <div className="ws-row">
                  <button type="button" className="btn" aria-disabled={busy || undefined} data-testid="ws-full-confirm" onClick={() => void confirm()}>{busy ? 'Starting…' : confirmLabel(asking.estimate)}</button>
                  <button type="button" className="btn s" data-testid="ws-full-cancel" onClick={cancel}>Do not run it</button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** The notices that something this bot depends on changed. Full cards in Live; in the other modes one line that says how many wait. */
export function ReassessmentNotices({ slug, botSlug, canManage, compact, onOpen }: { slug: string; botSlug: string; canManage: boolean; compact: boolean; onOpen: () => void }) {
  const [tick, setTick] = useState(0);
  const list = useQuery(`reassess:${slug}:${botSlug}:${String(tick)}`, () => listReassessments(slug, botSlug));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  if (list.status !== 'ok') return list.status === 'error' && !compact ? <Alert>{list.error.message || 'Could not load the things to check again.'}</Alert> : null;
  const open: Reassessment[] = list.data.reassessments;
  if (open.length === 0) return null;

  if (compact) {
    return (
      <p className="ws-notice-line" data-testid="ws-reassess-line">
        {noticesLine(open.length)}.{' '}
        <button type="button" className="ws-linkbtn" onClick={onOpen} data-testid="ws-reassess-open">See them in Live</button>
      </p>
    );
  }

  const close = async (n: Reassessment, answer: 'done' | 'dismissed'): Promise<void> => {
    if (busy) return;
    setBusy(n.id);
    setError(null);
    try {
      await closeReassessment(slug, botSlug, n.id, answer);
      setSaid(answer === 'done' ? 'Marked as checked.' : 'Dismissed.');
      setTick((t) => t + 1);
      window.setTimeout(() => headingRef.current?.focus(), 50);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="ws-reassess" aria-labelledby="ws-reassess-h" data-testid="ws-reassess">
      <h3 className="ws-h" id="ws-reassess-h" tabIndex={-1} ref={headingRef}>Check this again</h3>
      <p className="ws-hint">{noticesLine(open.length)}. Something this bot depends on changed. Nothing was run to find out: these are the things worth looking at again.</p>
      <p className="ws-sr" role="status" aria-live="polite">{said}</p>
      {error ? <Alert>{error}</Alert> : null}
      <ul className="ws-notices">
        {open.map((n) => (
          <li key={n.id} className="ws-reassess-card" data-testid="ws-reassess-card" data-reason={n.reason}>
            <p className="ws-reassess-reason">{REASON_WORDS[n.reason]}</p>
            <p className="ws-reassess-head">{n.headline}</p>
            <ul className="ws-checks">
              {n.checks.map((c) => <li key={c}>{c}</li>)}
            </ul>
            {canManage ? (
              <div className="ws-row">
                <button type="button" className="btn s" aria-disabled={busy !== null || undefined} data-testid="ws-reassess-done" onClick={() => void close(n, 'done')}>I checked this</button>
                <button type="button" className="btn s" aria-disabled={busy !== null || undefined} data-testid="ws-reassess-dismiss" onClick={() => void close(n, 'dismissed')}>It does not matter</button>
              </div>
            ) : (
              <p className="ws-hint">A team lead or an admin closes this notice.</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
