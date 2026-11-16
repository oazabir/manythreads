import { Link, useSearchParams } from 'react-router';
import { dismissOnboarding } from '../../api/endpoints';
import { isApiError } from '../../api/client';
import { Alert } from '../../components/ui';
import { useRef, useState } from 'react';
import { StepPanel } from './panels';
import type { OnboardingStep } from './steps';
import { announceOnboardingChange, useOnboarding } from './useOnboarding';
import { isStepOpen, stepOpenAtStart } from './fold';
import { PageHeader } from '../../components/PageHeader';

/*
 * Setup (PLAN P10-01, SPEC §16; Phase 27): the thirteen steps from a fresh install to a first delivery, one open at a time. Admin-only (the route sits under AdminOnly and
 * the settings nav shows it to admins only). What each step shows comes from `onboardingSteps` (steps.ts): a step is done when its fact is true,
 * never because a button was pressed. The only things this page records are decisions (password-only sign-in, an optional step set aside), the
 * first goal sent to Brain and the checklist being put away.
 */

function badge(step: OnboardingStep, next: boolean): { text: string; tone: string } {
  if (step.status === 'done') return { text: 'done', tone: 'ok' };
  if (step.status === 'skipped') return { text: 'set aside', tone: '' };
  if (step.optional) return { text: 'optional', tone: '' };
  return next ? { text: 'start here', tone: 'human' } : { text: 'to do', tone: '' };
}

export function Onboarding() {
  const view = useOnboarding('wizard');
  const [error, setError] = useState<string | null>(null);
  // What was already handled when the page opened is folded to one line. A step that is handled while the page is open stays as it is, so the
  // result of what the person just did is not taken away from under them. A person's own fold or unfold wins over both.
  const [params, setParams] = useSearchParams();
  const openAtStart = useRef<{ id: string | null } | null>(null);
  const [chosen, setChosen] = useState<Readonly<Record<string, boolean>>>({});
  /** Open the step after `from` (or the one named), fold `from`, and keep the address in step so a reload or a shared link lands there. */
  const go = (from: string, to: string): void => {
    setChosen((c) => ({ ...c, [from]: false, [to]: true }));
    setParams({ step: to }, { replace: true });
    window.requestAnimationFrame(() => document.getElementById(`ob-${to}`)?.scrollIntoView({ block: 'start' }));
  };

  return (
    <div className="onboarding ob" data-landmark="onboarding">
      <PageHeader title="Finish setting up" copyId="title" />
      <p className="lede" data-landmark="lede" data-copy="lede">
        From a new install to your first team job done by bots. One step is open at a time and you can leave and come back: this page opens where you stopped.
        Each step is ticked by what is really true (a model that answered a test, a runner that answered a real question, Brain on a team), never by a click.
        Steps marked optional never hold you up.
      </p>
      {view.status === 'loading' ? <div className="view-empty" aria-busy="true" /> : null}
      {view.status === 'error' ? <Alert>Could not read the setup state: {view.error.message}</Alert> : null}
      {view.status === 'ok' ? (
        (() => {
          const { summary, state, tests, aliases, hasProviders, facts } = view;
          const pct = Math.round((summary.handled / summary.total) * 100);
          openAtStart.current ??= { id: stepOpenAtStart(summary.steps, params.get('step')) };
          const startId = openAtStart.current.id;
          return (
            <>
              <div className="ob-progress" data-landmark="progress">
                <span data-testid="ob-count">{summary.handled} of {summary.total} steps done or set aside</span>
                <span className="ob-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
              </div>
              <section className="block" aria-label="Setup steps" data-landmark="steps">
                {summary.steps.map((s) => {
                  const next = summary.next?.id === s.id;
                  const b = badge(s, next);
                  const open = isStepOpen(s.id, startId, chosen);
                  const after = summary.after(s.id);
                  return (
                    <div key={s.id} className="ob-step" id={`ob-${s.id}`} data-step={s.id} data-done={s.done ? 'true' : 'false'} data-status={s.status} data-next={next ? 'true' : 'false'} data-open={open ? 'true' : 'false'}>
                      <span className="ob-num" aria-hidden="true">{s.n}</span>
                      <div>
                        <div className="ob-head" title={open ? undefined : s.hint}>
                          <span>{s.title}</span>
                          <span className={`chip ${b.tone}`}>{b.text}</span>
                          <button
                            type="button"
                            className="ob-toggle"
                            aria-expanded={open}
                            aria-controls={open ? `ob-body-${s.id}` : undefined}
                            aria-label={`${open ? 'Fold' : 'Open'} step ${s.n}, ${s.title}`}
                            data-testid={`ob-toggle-${s.id}`}
                            onClick={() => setChosen((c) => ({ ...c, [s.id]: !open }))}
                          >
                            <span className="ob-toggle-caret" aria-hidden="true" />
                          </button>
                        </div>
                        {open ? <p className="ob-hint">{s.hint}</p> : null}
                      </div>
                      {open ? (
                        <div className="ob-body" id={`ob-body-${s.id}`}>
                          <StepPanel step={s} summary={summary} state={state} tests={tests} aliases={aliases} hasProviders={hasProviders} facts={facts} />
                          {after ? (
                            <div className="ob-next">
                              <button type="button" className={`btn${s.status === 'todo' && !s.optional ? '' : ' primary'}`} data-testid={`ob-continue-${s.id}`} disabled={s.status === 'todo' && !s.optional} onClick={() => go(s.id, after.id)}>
                                {s.status === 'todo' && s.optional ? 'Skip for now and go on' : 'Continue'}
                              </button>
                              <span className="ob-test-d">{s.status === 'todo' && !s.optional ? 'Finish this step to go on.' : `Next: ${after.title}`}</span>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                <div className="ob-finish" data-landmark="finish">
                  {summary.dismissed ? (
                    <p>The checklist is put away. This page stays here if you want to look again.</p>
                  ) : summary.finished ? (
                    <>
                      <p>Everything required is done. You can put the checklist away; it leaves the sidebar.</p>
                      {summary.firstTeam ? <p className="ob-hint">Next, drop a document into <Link to={`/t/${summary.firstTeam.slug}/files`}>{summary.firstTeam.name}'s files</Link>: Brain learns from what the team keeps there.</p> : null}
                      <div className="ob-actions">
                        <button
                          type="button"
                          className="btn primary"
                          onClick={() => {
                            setError(null);
                            dismissOnboarding().then(announceOnboardingChange, (e: unknown) => setError(isApiError(e) ? e.message : 'Could not put the checklist away.'));
                          }}
                        >
                          Put the checklist away
                        </button>
                      </div>
                    </>
                  ) : (
                    <p>
                      {summary.next ? <>Next: step {summary.next.n}, {summary.next.title}. </> : null}
                      {summary.next ? <button type="button" className="btn primary" onClick={() => go('', summary.next?.id ?? '')}>Go to it</button> : null}
                    </p>
                  )}
                  {error ? <Alert>{error}</Alert> : null}
                </div>
              </section>
            </>
          );
        })()
      ) : null}
    </div>
  );
}
