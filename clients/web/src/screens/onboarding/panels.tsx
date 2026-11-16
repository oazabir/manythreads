import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { LlmAliasTest, OnboardingState } from '@manythreads/shared';
import { clearOnboardingMark, fetchNavChannels, launchOnboarding, postMessage, setOnboardingMark } from '../../api/endpoints';
import { usePeople } from '../../channels/hooks';
import { RunCard } from '../../channels/run-card/RunCard';
import { runEnded } from '../../channels/run-card/words';
import { Alert } from '../../components/ui';
import { fetchThreadRuns } from '../../runs/api';
import { openConversation } from '../conversations/api';
import { createProject } from '../projects/api';
import type { OnboardingStep, OnboardingSummary } from './steps';
import { BotsStep, HttpsStep, ModelSetup, OrganizationStep, RunnersStep, ServersStep, TeamsStep, ThemeStep, useAction } from './panels-setup';
import { announceOnboardingChange, type BoundAlias, type WizardFacts } from './useOnboarding';

/* The controls of each step of the setup wizard (PLAN P10-01, Phase 27). A button either does the work on the server or only re-reads a fact; none of them ticks a step. */

/** "Check again": re-reads the facts. It never marks anything done; if nothing changed, the step stays as it was. */
function CheckAgain() {
  return (
    <button type="button" className="btn" onClick={announceOnboardingChange}>
      Check again
    </button>
  );
}

type SettableStep = 'theme' | 'code' | 'infrastructure' | 'servers' | 'delivery';

/** Set an optional step aside, or take that back. */
function SetAside({ step, state, label = 'We do not need this' }: { step: SettableStep; state: OnboardingState; label?: string }) {
  const act = useAction();
  const set = state.marks.some((m) => m.step === step && m.kind === 'skipped');
  return (
    <>
      <button
        type="button"
        className="btn quiet"
        disabled={act.busy}
        data-testid={`ob-aside-${step}`}
        onClick={() =>
          void act.run(async () => {
            if (set) await clearOnboardingMark(step);
            else await setOnboardingMark(step, 'skipped');
            announceOnboardingChange();
          })
        }
      >
        {set ? 'Undo, I do want this' : label}
      </button>
      {act.error ? <Alert>{act.error}</Alert> : null}
    </>
  );
}

function SignIn({ step, state }: { step: OnboardingStep; state: OnboardingState }) {
  const act = useAction();
  const acknowledged = state.marks.some((m) => m.step === 'signin');
  return (
    <>
      <div className="ob-actions">
        <Link className="btn" to="/settings/workspace/sign-in">Open sign-in methods</Link>
        {step.done && !acknowledged ? null : (
          <button
            type="button"
            className="btn"
            disabled={act.busy}
            data-testid="ob-signin-password"
            onClick={() =>
              void act.run(async () => {
                if (acknowledged) await clearOnboardingMark('signin');
                else await setOnboardingMark('signin', 'acknowledged');
                announceOnboardingChange();
              })
            }
          >
            {acknowledged ? 'Undo, I will add single sign-on' : 'Passwords only is what we want'}
          </button>
        )}
      </div>
      {act.error ? <Alert>{act.error}</Alert> : null}
    </>
  );
}

const STARTER_URL = 'https://github.com/manythreads/starter';

function CodeStep({ step, summary, state }: { step: OnboardingStep; summary: OnboardingSummary; state: OnboardingState }) {
  const act = useAction();
  const [name, setName] = useState('starter');
  const [repo, setRepo] = useState('');
  const team = summary.firstTeam;
  return (
    <>
      <p className="ob-hint">
        A project is a Git repository bots may read and change. If you have none to try, make your own copy of the{' '}
        <a href={STARTER_URL} target="_blank" rel="noreferrer">starter repository</a> ("Use this template" on GitHub): one page, one test, ready for a first delivery.
      </p>
      {team && !step.done ? (
        <form
          className="ob-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act.run(async () => {
              await createProject(team.slug, { name: name.trim(), repoUrl: repo.trim() });
              announceOnboardingChange();
            });
          }}
        >
          <label>
            Project name
            <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="ob-project-name" />
          </label>
          <label>
            Repository address
            <input value={repo} placeholder="https://github.com/you/starter" onChange={(e) => setRepo(e.target.value)} data-testid="ob-project-repo" />
          </label>
          <button type="submit" className="btn primary" disabled={act.busy || name.trim() === '' || repo.trim() === ''} data-testid="ob-project-add">
            {act.busy ? 'Adding…' : `Add to ${team.name}`}
          </button>
        </form>
      ) : null}
      {act.error ? <Alert>{act.error}</Alert> : null}
      <div className="ob-actions">
        {step.to ? <Link className="btn" to={step.to}>{step.done ? 'Open Projects' : 'Add the access token in Projects'}</Link> : null}
        <CheckAgain />
        {step.done ? null : <SetAside step="code" state={state} />}
      </div>
    </>
  );
}

/** The runs of a thread, drawn as the run cards the channel draws, read again while one is going. */
function ThreadRuns({ rootId, slug }: { rootId: string; slug: string }) {
  const people = usePeople();
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof fetchThreadRuns>>['runs']>([]);
  const going = runs.length === 0 || runs.some((r) => !runEnded(r.state));
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void fetchThreadRuns(rootId).then(
        (r) => live && setRuns(r.runs),
        () => undefined,
      );
    };
    read();
    if (!going) return () => { live = false; };
    const t = setInterval(read, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [rootId, going]);
  if (runs.length === 0) return <p className="ob-hint" role="status">Waiting for the bot to pick it up…</p>;
  return (
    <div className="ob-runs" data-testid="ob-runs">
      {runs.map((r) => (
        <RunCard key={r.runId} head={r} rootId={rootId} slug={slug} people={people} />
      ))}
    </div>
  );
}

const EXAMPLES = [
  'What is this team responsible for, and where do I start?',
  'What should a new person on this team read first?',
  'Which decisions did we write down, and why?',
];

function Launch({ summary, state, step }: { summary: OnboardingSummary; state: OnboardingState; step: OnboardingStep }) {
  const navigate = useNavigate();
  const [goal, setGoal] = useState(EXAMPLES[0] as string);
  const act = useAction();
  const team = summary.firstTeam;
  if (!team || !summary.brainChat) return <p className="ob-hint">Brain has to be on a team first. Finish the steps above.</p>;
  const sent = state.launch !== null;
  const root = state.launch?.messageId ?? null;
  return (
    <>
      {sent && root ? <ThreadRuns rootId={root} slug={team.slug} /> : null}
      {step.done ? null : (
        <>
          <div className="ob-goal">
            <label className="ob-hint" htmlFor="ob-goal-text">What do you want to ask Brain?</label>
            <textarea id="ob-goal-text" value={goal} maxLength={2000} onChange={(e) => setGoal(e.target.value)} />
            <div className="ob-prompts">
              {EXAMPLES.map((q) => (
                <button key={q} type="button" className="btn quiet" onClick={() => setGoal(q)}>{q}</button>
              ))}
            </div>
          </div>
          <div className="ob-actions">
            <button
              type="button"
              className="btn primary"
              disabled={act.busy || goal.trim() === ''}
              data-testid="ob-launch-ask"
              onClick={() =>
                void act.run(async () => {
                  const opened = await openConversation(team.slug, 'brain');
                  const posted = await postMessage(opened.channelId, goal.trim());
                  await launchOnboarding({ teamId: team.id as never, channelId: opened.channelId, messageId: posted.id as never });
                  announceOnboardingChange();
                })
              }
            >
              {act.busy ? 'Sending…' : sent ? 'Ask this too' : 'Ask Brain'}
            </button>
            {sent ? <Link className="btn" to={summary.brainChat}>Open the conversation</Link> : null}
          </div>
        </>
      )}
      {act.error ? <Alert>{act.error}</Alert> : null}
      {sent && !step.done && !root ? (
        <button type="button" className="btn quiet" onClick={() => void navigate(summary.brainChat as string)}>Open the conversation</button>
      ) : null}
    </>
  );
}

const DELIVERY_GOAL =
  'Add a page at /hello to the starter app that shows the name of the team. Test it, deploy it to the preview and open a pull request.';

function DeliveryStep({ step, summary, facts, state }: { step: OnboardingStep; summary: OnboardingSummary; facts: WizardFacts; state: OnboardingState }) {
  const act = useAction();
  const engineering = facts.teams.find((t) => t.template === 'engineering') ?? null;
  const started = state.marks.find((m) => m.step === 'delivery' && m.kind === 'started');
  const root = started?.refId ?? null;
  return (
    <>
      <p className="ob-hint">
        The Engineer is the bot that writes code. This asks it to make a small change to the starter repository, test it, put it on a preview and open a pull request,
        so you see a whole team job from start to end. It takes a few minutes and uses a little of your model budget.
      </p>
      {engineering && root ? <ThreadRuns rootId={root} slug={engineering.slug} /> : null}
      {step.done || started ? null : (
        <div className="ob-actions">
          <button
            type="button"
            className="btn primary"
            disabled={act.busy || !engineering || summary.next !== null}
            data-testid="ob-delivery-start"
            onClick={() =>
              void act.run(async () => {
                if (!engineering) return;
                const groups = await fetchNavChannels(engineering.slug);
                const dev = groups.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'dev');
                if (!dev) throw new Error('This team has no dev channel to post the job in.');
                const posted = await postMessage(dev.id, `@engineer ${DELIVERY_GOAL}`);
                await setOnboardingMark('delivery', 'started', posted.id);
                announceOnboardingChange();
              })
            }
          >
            {act.busy ? 'Sending…' : 'Give the Engineer the job'}
          </button>
          {!engineering ? <span className="ob-test-d">This needs the Engineering team and a project with a token.</span> : null}
          {engineering && summary.next !== null ? <span className="ob-test-d">Finish the required steps first.</span> : null}
        </div>
      )}
      <div className="ob-actions">
        {step.to ? <Link className="btn" to={`/t/${engineering?.slug ?? ''}/tasks`}>Open the task board</Link> : null}
        <CheckAgain />
        {step.done ? null : <SetAside step="delivery" state={state} label="Skip the first delivery" />}
      </div>
      {act.error ? <Alert>{act.error}</Alert> : null}
    </>
  );
}

export interface PanelProps {
  step: OnboardingStep;
  summary: OnboardingSummary;
  state: OnboardingState;
  tests: LlmAliasTest[];
  aliases: BoundAlias[];
  hasProviders: boolean;
  facts: WizardFacts;
}

export function StepPanel({ step, summary, state, tests, aliases, hasProviders, facts }: PanelProps): ReactNode {
  switch (step.id) {
    case 'bootstrap':
      return <div className="ob-actions"><Link className="btn" to="/settings/workspace/general">Review</Link></div>;
    case 'theme':
      return <ThemeStep step={step} />;
    case 'organization':
      return <OrganizationStep facts={facts} />;
    case 'infrastructure':
      return <HttpsStep step={step} secure={window.location.protocol === 'https:'} setAside={step.done ? null : <SetAside step="infrastructure" state={state} />} />;
    case 'models':
      return <ModelSetup tests={tests} aliases={aliases} hasProviders={hasProviders} />;
    case 'signin':
      return <SignIn step={step} state={state} />;
    case 'teams':
      return <TeamsStep facts={facts} />;
    case 'servers':
      return <ServersStep step={step} setAside={step.done ? null : <SetAside step="servers" state={state} />} />;
    case 'runners':
      return <RunnersStep step={step} summary={summary} facts={facts} tests={tests} aliases={aliases} hasProviders={hasProviders} state={state} />;
    case 'bots':
      return <BotsStep step={step} summary={summary} facts={facts} />;
    case 'code':
      return <CodeStep step={step} summary={summary} state={state} />;
    case 'launch':
      return <Launch summary={summary} state={state} step={step} />;
    case 'delivery':
      return <DeliveryStep step={step} summary={summary} facts={facts} state={state} />;
  }
}

