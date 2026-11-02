import { useId } from 'react';
import { switchMode, teamsProblem, toggleTeam, type TeamsChoice } from './commands';

export type TeamOption = { id: string; name: string };

/*
 * "Who may use this runner": every team, one team, or several. The list is the permission (docs/plugins/bot-runners.md): a team that is not on it cannot see the
 * runner at all. The three radio buttons are the two shortcuts of the plan (This team only, Share with several teams) and the open door (Every team).
 */
export function TeamsControl({ value, onChange, teams, legend = 'Which teams may use it' }: { value: TeamsChoice; onChange: (v: TeamsChoice) => void; teams: readonly TeamOption[]; legend?: string }) {
  const name = useId();
  const selectId = useId();
  const problem = teamsProblem(value);
  const modes: Array<{ mode: TeamsChoice['mode']; label: string; hint: string }> = [
    { mode: 'one', label: 'This team only', hint: 'Pick the one team that may use it.' },
    { mode: 'several', label: 'Share with several teams', hint: 'Tick each team that may use it.' },
    { mode: 'all', label: 'Every team', hint: 'Every team in the workspace, including teams made later.' },
  ];
  return (
    <fieldset className="rn-teams" data-testid="runner-teams-control">
      <legend>{legend}</legend>
      {modes.map((m) => (
        <div key={m.mode} className="rn-teams-opt">
          <label className="check">
            <input type="radio" name={name} checked={value.mode === m.mode} onChange={() => onChange(switchMode(value, m.mode))} data-testid={`runner-teams-${m.mode}`} /> {m.label}
          </label>
          <span className="fld-hint">{m.hint}</span>
          {m.mode === 'one' && value.mode === 'one' ? (
            <div className="rn-teams-pick">
              <label htmlFor={selectId} className="sr-only">Team</label>
              <select id={selectId} value={value.teamId} onChange={(e) => onChange({ mode: 'one', teamId: e.target.value })} data-testid="runner-teams-select">
                <option value="">Choose a team</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          ) : null}
          {m.mode === 'several' && value.mode === 'several' ? (
            <ul className="rn-teams-list">
              {teams.map((t) => (
                <li key={t.id}>
                  <label className="check">
                    <input type="checkbox" checked={value.teamIds.includes(t.id)} onChange={(e) => onChange(toggleTeam(value, t.id, e.target.checked))} data-testid={`runner-team-${t.id}`} /> {t.name}
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
      {problem ? <p className={problem.kind === 'error' ? 'dlg-error' : 'fld-hint rn-warn'} role={problem.kind === 'error' ? 'alert' : undefined}>{problem.text}</p> : null}
    </fieldset>
  );
}
