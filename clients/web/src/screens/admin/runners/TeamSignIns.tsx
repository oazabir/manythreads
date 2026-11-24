import { useCallback, useEffect, useId, useState } from 'react';
import type { AgentAuthTeamState, BotRunner, BotRunnerSignInScope } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { Dialog } from '../../../components/Dialog';
import { fetchAgentAuthTeams, setSignInScope } from './api';
import { AGENT_NAME, agentOf, SCOPE_HINT, SCOPE_LABEL, scopeSwitchWords, teamAction, teamSignedIn, teamsSignedInWords, teamStateWords, type TeamRef } from './agent-auth';

/*
 * Who signs a Claude Code or Codex pod runner in (P35-10, docs/plans/per-team-sign-in.md section 1). `SignInScopeDialog` is the choice, one sign-in for all teams (the default) or each
 * team on its own, and says what a switch does before it is done (every old sign-in is signed out and removed, runs under way stop, the shell homes are cleared). `TeamSignInsDialog`
 * lists the teams of a runner where each team signs in, each with its stored state, and opens the usual sign-in dialog for one team. The list is the server's stored states: no team is
 * asked live here, so the list opens at once.
 */

const message = (e: unknown): string => (isApiError(e) ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.');

const SCOPES: readonly BotRunnerSignInScope[] = ['shared', 'per_team'];

export function SignInScopeDialog({ runner, onClose, onDone }: { runner: BotRunner; onClose: () => void; onDone: (r: BotRunner, text: string) => void }) {
  const [choice, setChoice] = useState<BotRunnerSignInScope>(runner.signInScope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  const switching = choice !== runner.signInScope;

  async function apply(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await setSignInScope(runner.id, choice);
      onDone(res.runner, choice === 'per_team' ? `${runner.label}: each team signs in now. Sign each team in from Sign-in.` : `${runner.label}: one sign-in for all teams now. Sign it in from Sign-in.`);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Who signs ${runner.label} in`}
      onClose={onClose}
      testId="runner-signin-scope-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{switching ? 'Cancel' : 'Close'}</button>
          {switching ? (
            <button type="button" className="btn danger" onClick={() => void apply()} disabled={busy} data-testid="runner-scope-confirm">
              {busy ? 'Signing out…' : `Switch to “${SCOPE_LABEL[choice]}”`}
            </button>
          ) : null}
        </>
      }
    >
      <fieldset className="rn-teams" data-testid="runner-scope-control">
        <legend>Sign-in</legend>
        {SCOPES.map((s) => (
          <div key={s} className="rn-teams-opt">
            <label className="check">
              <input type="radio" name={name} checked={choice === s} onChange={() => setChoice(s)} disabled={busy} data-testid={`runner-scope-${s === 'per_team' ? 'per-team' : 'shared'}`} /> {SCOPE_LABEL[s]}
              {runner.signInScope === s ? ' (now)' : ''}
            </label>
            <span className="fld-hint">{SCOPE_HINT[s]}</span>
          </div>
        ))}
      </fieldset>
      {switching ? (
        <p className="dlg-text rn-warn" role="alert" data-testid="runner-scope-words">{scopeSwitchWords(runner, choice)}</p>
      ) : null}
      {error ? <p className="dlg-error" role="alert" data-testid="runner-scope-error">{error}</p> : null}
    </Dialog>
  );
}

/** The list of a runner's teams and their sign-ins. `onTeam` opens the sign-in dialog for one team (the caller's `AgentSignInDialog` with that team). */
export function TeamSignInsDialog({ runner, onClose, onTeam, onScope }: { runner: BotRunner; onClose: () => void; onTeam: (team: TeamRef) => void; onScope: () => void }) {
  const [items, setItems] = useState<AgentAuthTeamState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await fetchAgentAuthTeams(runner.id)).items);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [runner.id]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Dialog title={`Team sign-ins for ${runner.label}`} onClose={onClose} wide testId="runner-team-signins-dialog" footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <TeamSignInsView runner={runner} items={items} error={error} onTeam={onTeam} onScope={onScope} />
    </Dialog>
  );
}

/** The list itself, with no state of its own, so a test renders every case. */
export function TeamSignInsView({ runner, items, error, onTeam, onScope }: { runner: BotRunner; items: readonly AgentAuthTeamState[] | null; error: string | null; onTeam: (team: TeamRef) => void; onScope: () => void }) {
  const which = agentOf(runner);
  const tool = which === null ? 'the agent' : AGENT_NAME[which];
  const served = items?.filter((t) => t.served) ?? [];
  return (
    <div className="rn-form">
      <p className="dlg-text">
        Each team of this runner signs in to {tool} with an account of its own. A team that is not signed in has no working runner: its bots&apos; runs end at once.{' '}
        <button type="button" className="btn sm" onClick={onScope} data-testid="runner-team-signins-scope">Change who signs in</button>
      </p>
      {items === null && error === null ? <p className="dlg-text faint" role="status">Loading the teams.</p> : null}
      {items !== null ? (
        <>
          <p className="fld-hint" role="status" data-testid="runner-team-signins-count">{teamsSignedInWords(served.filter(teamSignedIn).length, served.length)}.</p>
          {items.length === 0 ? (
            <p className="faint" data-testid="runner-team-signins-none">No team may use this runner yet. Add teams with Teams first.</p>
          ) : (
            <ul className="rn-auth-methods" data-testid="runner-team-signins-list">
              {items.map((t) => {
                const action = teamAction(t);
                return (
                  <li key={t.teamId} data-testid="runner-team-signin-row" data-team={t.slug} data-state={t.served ? (t.state ?? 'unknown') : 'no_pod'}>
                    <strong>{t.name}</strong> <span className="fld-hint" data-testid="runner-team-signin-state">{teamStateWords(t)}</span>{' '}
                    {action !== null ? (
                      <button type="button" className="btn sm" onClick={() => onTeam({ slug: t.slug, name: t.name })} data-testid="runner-team-signin-open" aria-label={`${action}: team ${t.name}`}>
                        {action}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
      {error ? <p className="dlg-error" role="alert" data-testid="runner-team-signins-error">{error}</p> : null}
    </div>
  );
}
