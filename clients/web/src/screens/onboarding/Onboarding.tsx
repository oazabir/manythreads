import { Link } from 'react-router';
import { dismissOnboarding } from '../../api/endpoints';
import { isApiError } from '../../api/client';
import { Alert } from '../../components/ui';
import { useState } from 'react';
import { StepPanel } from './panels';
import type { OnboardingStep } from './steps';
import { announceOnboardingChange, useOnboarding } from './useOnboarding';

/*
 * Setup (PLAN P10-01, SPEC §16): the nine steps from a fresh install to a first answer from Brain. Admin-only (the route sits under AdminOnly and
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

  return (
    <div className="onboarding ob" data-landmark="onboarding">
      <h1 className="pane-title" data-landmark="title" data-copy="title">Finish setting up</h1>
      <p className="lede" data-landmark="lede" data-copy="lede">
        Nine steps from a new install to your first answer from Brain, the bot that reads your team's memory. Each step is ticked by what is
        really true: a model that answered a test, a team that exists, Brain on it. Steps marked optional never hold you up.
      </p>
      {view.status === 'loading' ? <div className="view-empty" aria-busy="true" /> : null}
      {view.status === 'error' ? <Alert>Could not read the setup state: {view.error.message}</Alert> : null}
      {view.status === 'ok' ? (
        (() => {
          const { summary, state, tests, aliases, hasProviders } = view;
          const pct = Math.round((summary.handled / summary.total) * 100);
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
                  return (
                    <div key={s.id} className="ob-step" id={`ob-${s.id}`} data-step={s.id} data-done={s.done ? 'true' : 'false'} data-status={s.status} data-next={next ? 'true' : 'false'}>
                      <span className="ob-num" aria-hidden="true">{s.n}</span>
                      <div>
                        <div className="ob-head">
                          <span>{s.title}</span>
                          <span className={`chip ${b.tone}`}>{b.text}</span>
                        </div>
                        <p className="ob-hint">{s.hint}</p>
                      </div>
                      <div className="ob-body">
                        <StepPanel step={s} summary={summary} state={state} tests={tests} aliases={aliases} hasProviders={hasProviders} />
                      </div>
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
                      {summary.next ? <a className="btn primary" href={`#ob-${summary.next.id}`}>Go to it</a> : null}
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
