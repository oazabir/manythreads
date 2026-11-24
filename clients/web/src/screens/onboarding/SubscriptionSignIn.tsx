import { useCallback, useEffect, useState } from 'react';
import type { BotRunner } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { AgentSignInDialog } from '../admin/runners/AgentSignInDialog';
import { createBotRunner, fetchBotRunners, updateBotRunner } from '../admin/runners/api';
import { announceOnboardingChange } from './useOnboarding';

/*
 * Claude Code and Codex in the setup wizard (owner request 2026-11-24): the same sign-in as Settings → Runners, without leaving the wizard. "Set up" makes the runner in this site's
 * cluster (a pod for all teams) if there is none, then opens the sign-in: the pod starts the tool, the dialog shows the page the tool asks the person to open (and the code to type
 * there, or a box for the code that page gives back, or for an API key), and the runner is ready once the tool says it is signed in. A runner that needs a new sign-in shows
 * "Sign in again" here too. Offered only where this site can run pods.
 */

type Agent = { kind: 'claude_cli' | 'codex_cli'; name: string; label: string; plan: string };

const AGENTS: readonly Agent[] = [
  { kind: 'claude_cli', name: 'claude', label: 'Claude Code', plan: 'a Claude subscription (Pro or Max) or an Anthropic API key' },
  { kind: 'codex_cli', name: 'codex', label: 'Codex', plan: 'a ChatGPT plan or an OpenAI API key' },
];

const STATE: Record<string, string> = {
  ready: 'signed in',
  starting: 'starting',
  waiting_for_sign_in: 'not signed in',
  needs_sign_in: 'sign-in expired',
  not_set_up: 'not set up',
  paused: 'paused (plan limit)',
};

/** A runner name not yet taken: `claude`, else `claude-2`, ... */
export const freeName = (base: string, taken: readonly string[]): string => {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
};

export function SubscriptionSignIn() {
  const [runners, setRunners] = useState<BotRunner[] | null>(null);
  const [pods, setPods] = useState(false);
  const [open, setOpen] = useState<BotRunner | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetchBotRunners();
    setRunners(r.items);
    setPods(r.claudePodsAvailable);
    return r.items;
  }, []);

  useEffect(() => {
    load().catch(() => setRunners([]));
  }, [load]);

  if (runners === null || !pods) return null;

  const setUp = async (a: Agent, existing: BotRunner | undefined): Promise<void> => {
    setBusy(a.kind);
    setError(null);
    try {
      let runner = existing;
      if (runner === undefined) {
        runner = (await createBotRunner({ name: freeName(a.name, runners.map((r) => r.name)), label: a.label, kind: a.kind, teams: { all: true } })).runner;
      } else if (!runner.enabled) {
        runner = (await updateBotRunner(runner.id, { enabled: true })).runner;
      }
      await load();
      announceOnboardingChange();
      setOpen(runner);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'It could not be set up. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ob-offer ob-subs" data-testid="ob-subscriptions">
      <h3 className="ob-offer-title">Use your Claude Code or Codex plan</h3>
      <p className="ob-hint">
        Bots can run on Claude Code or Codex in this site's cluster. Set one up and sign in here: it shows you the page to open, and you paste back the code that page gives you.
      </p>
      <ul className="ob-rows">
        {AGENTS.map((a) => {
          const r = runners.find((x) => x.kind === a.kind);
          const ready = r !== undefined && r.enabled && r.status === 'ready';
          const words = r === undefined ? 'not set up' : !r.enabled ? 'turned off' : (STATE[r.status] ?? r.status.replaceAll('_', ' '));
          return (
            <li key={a.kind} className="ob-alias ob-runner" data-testid={`ob-sub-${a.kind}`} data-ready={ready ? 'true' : 'false'}>
              <span className="ob-runner-name">{a.label}</span>
              <span className="ob-test-d">Needs {a.plan}.</span>
              <span>
                {r !== undefined && r.uploadedAt !== null ? (
                  <span className="ob-test-d">Signed in with an uploaded file: change it in Runners.</span>
                ) : (
                  <button type="button" className={`btn sm ${ready ? '' : 'primary'}`} disabled={busy !== null} onClick={() => void setUp(a, r)} data-testid={`ob-sub-signin-${a.kind}`}>
                    {busy === a.kind ? 'Setting up…' : r === undefined ? `Set up ${a.label}` : ready ? 'Sign-in…' : r.status === 'needs_sign_in' ? 'Sign in again' : 'Sign in'}
                  </button>
                )}
              </span>
              <span className="ob-test">
                <span className={`chip ${ready ? 'ok' : 'warn'}`}>{words}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {note ? <p className="ob-hint" role="status">{note}</p> : null}
      {error ? <p className="dlg-error" role="alert">{error}</p> : null}
      {open ? (
        <AgentSignInDialog
          runner={open}
          onClose={() => {
            setOpen(null);
            void load().then(() => announceOnboardingChange());
          }}
          onChanged={(text) => {
            setNote(text);
            void load().then(() => announceOnboardingChange());
          }}
        />
      ) : null}
    </div>
  );
}
