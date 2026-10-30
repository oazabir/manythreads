import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { LlmAliasTest, OnboardingState, TemplateSummary } from '@manythreads/shared';
import { LLM_TESTABLE_ALIASES } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import {
  applyTeamTemplate,
  clearOnboardingMark,
  fetchTemplates,
  launchOnboarding,
  postMessage,
  setOnboardingMark,
} from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { AliasTestButton, AliasTestStatus } from '../../components/AliasTest';
import { Alert } from '../../components/ui';
import { openConversation } from '../conversations/api';
import type { OnboardingStep, OnboardingSummary } from './steps';
import { announceOnboardingChange, type BoundAlias } from './useOnboarding';

/* The controls of each step of the setup wizard (PLAN P10-01). A button either does the work on the server or only re-reads a fact; none of them ticks a step. */

const failure = (e: unknown): string => (isApiError(e) ? e.message : 'Something went wrong. Try again.');

function useAction(): { busy: boolean; error: string | null; run: (fn: () => Promise<void>) => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    busy,
    error,
    async run(fn) {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(failure(e));
      } finally {
        setBusy(false);
      }
    },
  };
}

/** "Check again": re-reads the facts. It never marks anything done; if nothing changed, the step stays as it was. */
function CheckAgain() {
  return (
    <button type="button" className="btn" onClick={announceOnboardingChange}>
      Check again
    </button>
  );
}

/** Set an optional step aside, or take that back. */
function SetAside({ step, state }: { step: 'code' | 'infrastructure' | 'servers'; state: OnboardingState }) {
  const act = useAction();
  const set = state.marks.some((m) => m.step === step);
  return (
    <>
      <button
        type="button"
        className="btn quiet"
        disabled={act.busy}
        onClick={() =>
          void act.run(async () => {
            if (set) await clearOnboardingMark(step);
            else await setOnboardingMark(step, 'skipped');
            announceOnboardingChange();
          })
        }
      >
        {set ? 'Undo, I do want this' : 'We do not need this'}
      </button>
      {act.error ? <Alert>{act.error}</Alert> : null}
    </>
  );
}

function Models({ tests, aliases, hasProviders }: { tests: LlmAliasTest[]; aliases: BoundAlias[]; hasProviders: boolean }) {
  const byAlias = new Map(tests.map((t) => [t.alias as string, t]));
  const testable = new Set<string>(LLM_TESTABLE_ALIASES);
  const bound = aliases.filter((a) => testable.has(a.alias));
  return (
    <>
      {bound.length === 0 ? (
        <p className="ob-hint" data-testid="ob-models-empty">
          {hasProviders ? 'No model is connected to a name yet. Open model settings, give smart a model, and save.' : 'No model provider yet. Open model settings and add one with its key.'}
        </p>
      ) : null}
      <div className="ob-rows">
        {bound.map((a) => (
          <div key={a.alias} className="ob-alias" data-alias={a.alias}>
            <span className="mono">{a.alias}</span>
            <span className="ob-test-d">{a.model}</span>
            <span>
              <AliasTestButton alias={a.alias} onResult={announceOnboardingChange} />
            </span>
            <AliasTestStatus test={byAlias.get(a.alias)} />
          </div>
        ))}
      </div>
      <div className="ob-actions">
        <Link className="btn" to="/settings/workspace/llm">Open model settings</Link>
        <CheckAgain />
      </div>
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

function CreateTeam() {
  const templates = useQuery('ob-templates', fetchTemplates);
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const act = useAction();
  const list: TemplateSummary[] = templates.status === 'ok' ? templates.data.templates : [];
  const chosen = templateId || list.find((t) => t.id === 'engineering')?.id || list[0]?.id || '';
  return (
    <form
      className="ob-form"
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(async () => {
          await applyTeamTemplate({ templateId: chosen, ...(name.trim() ? { name: name.trim() } : {}) });
          setName('');
          announceOnboardingChange();
        });
      }}
    >
      <label>
        Template
        <select value={chosen} onChange={(e) => setTemplateId(e.target.value)} disabled={list.length === 0}>
          {list.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </label>
      <label>
        Team name
        <input value={name} maxLength={60} placeholder="Engineering" onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="submit" className="btn primary" disabled={act.busy || chosen === ''}>
        {act.busy ? 'Creating…' : 'Create team'}
      </button>
      {act.error ? <Alert>{act.error}</Alert> : null}
    </form>
  );
}

const EXAMPLES = [
  'What is this team responsible for, and where do I start?',
  'What should a new person on this team read first?',
  'Which decisions did we write down, and why?',
];

function Launch({ summary, state }: { summary: OnboardingSummary; state: OnboardingState }) {
  const navigate = useNavigate();
  const [goal, setGoal] = useState(EXAMPLES[0] as string);
  const act = useAction();
  const team = summary.firstTeam;
  if (!team || !summary.brainChat) return null;
  const sent = state.launch !== null;
  return (
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
          onClick={() =>
            void act.run(async () => {
              const opened = await openConversation(team.slug, 'brain');
              const root = await postMessage(opened.channelId, goal.trim());
              try {
                await launchOnboarding({ teamId: team.id as never, channelId: opened.channelId });
              } catch {
                // the question is already sent: land in its thread anyway, and the checklist asks again because the step is still not done
              }
              announceOnboardingChange();
              void navigate(`/t/${team.slug}/bots/brain/chat?thread=${root.id}`);
            })
          }
        >
          {act.busy ? 'Sending…' : sent ? 'Ask this too' : 'Ask Brain'}
        </button>
        {sent ? <Link className="btn" to={summary.brainChat}>Open the conversation</Link> : null}
      </div>
      {act.error ? <Alert>{act.error}</Alert> : null}
    </>
  );
}

export function StepPanel({ step, summary, state, tests, aliases, hasProviders }: { step: OnboardingStep; summary: OnboardingSummary; state: OnboardingState; tests: LlmAliasTest[]; aliases: BoundAlias[]; hasProviders: boolean }): ReactNode {
  switch (step.id) {
    case 'bootstrap':
      return <div className="ob-actions"><Link className="btn" to="/settings/workspace/general">Review</Link></div>;
    case 'signin':
      return <SignIn step={step} state={state} />;
    case 'models':
      return <Models tests={tests} aliases={aliases} hasProviders={hasProviders} />;
    case 'code':
      return (
        <div className="ob-actions">
          {step.to ? <Link className="btn" to={step.to}>Open Projects</Link> : null}
          <CheckAgain />
          {step.done ? null : <SetAside step="code" state={state} />}
        </div>
      );
    case 'infrastructure':
      return (
        <div className="ob-actions">
          <Link className="btn" to="/settings/workspace/https">Open Domain and HTTPS</Link>
          <CheckAgain />
          {step.done ? null : <SetAside step="infrastructure" state={state} />}
        </div>
      );
    case 'teams':
      return summary.firstTeam ? (
        <div className="ob-actions">
          <Link className="btn" to="/teams">Manage teams</Link>
        </div>
      ) : (
        <CreateTeam />
      );
    case 'bots':
      return step.done ? null : (
        <div className="ob-actions">
          {step.to ? <Link className="btn" to={step.to}>Open the team's bots</Link> : null}
          <CheckAgain />
        </div>
      );
    case 'servers':
      return (
        <div className="ob-actions">
          <CheckAgain />
          {step.done ? null : <SetAside step="servers" state={state} />}
        </div>
      );
    case 'launch':
      return <Launch summary={summary} state={state} />;
  }
}
