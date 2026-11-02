import { useId } from 'react';
import type { BotFrontmatter, TeamBotRunner } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { fetchTeamRunners } from './api';
import { DEFAULT_CANNOT_RUN, KIND_ICON, KIND_LABEL, STATUS_LABEL, canRunBots, chosenNote, defaultApplies, hasOldPlacement, moveTarget, movedPlacement, oldPlacement, optionText, pickedPlacement, planLine } from './runs-on';

/*
 * Where a bot runs (PLAN P19-03). One choice, "Runs on": the runners an admin set up and this team may use, each with its kind mark and its state. The default runner is
 * the one a bot without a choice uses, so the empty choice reads "Workspace default" and names it. A runner that is not Ready can be chosen and says so under the list.
 * No address, key or node is ever drawn: the server never sends them to this page.
 *
 * A bot written before runners existed may still name a Hermes connection, a node or a runner machine. Those show read-only under "Old placement", with one button that
 * moves the bot to a runner in the draft (saving is the same save as any other change of the definition).
 *
 * Someone who may not edit the bot sees the answer as text and no select.
 */

type Placement = BotFrontmatter['placement'];

const STATE_TONE: Readonly<Record<TeamBotRunner['status'], 'ok' | 'warn' | 'off'>> = {
  ready: 'ok',
  not_set_up: 'warn',
  waiting_for_sign_in: 'warn',
  starting: 'warn',
  needs_sign_in: 'warn',
  waiting_for_node: 'warn',
  moving: 'warn',
  paused: 'warn',
  off: 'off',
};

function RunnerState({ runner }: { runner: TeamBotRunner }) {
  return (
    <span className={`b-state ${STATE_TONE[runner.status] === 'ok' ? '' : STATE_TONE[runner.status]}`} data-testid="runs-on-state" data-state={runner.status}>
      <span className={`dot ${STATE_TONE[runner.status] === 'ok' ? '' : STATE_TONE[runner.status]}`} aria-hidden="true" />
      {STATUS_LABEL[runner.status]}
    </span>
  );
}

function ChosenRunner({ runner }: { runner: TeamBotRunner }) {
  const note = chosenNote(runner);
  const plan = planLine(runner);
  return (
    <div className="b-runner" data-testid="runs-on-chosen">
      <div className="b-runner-head">
        <span className="b-runner-icon" aria-hidden="true">{KIND_ICON[runner.kind]}</span>
        <span className="b-runner-name">{runner.label}</span>
        <span className="b-runner-kind">{KIND_LABEL[runner.kind]}</span>
        <RunnerState runner={runner} />
      </div>
      {plan !== null ? <div className="b-hint" data-testid="runs-on-plan">{plan}</div> : null}
      <div className={note.tone === 'warn' ? 'b-warnline' : 'b-hint'} role={note.tone === 'warn' ? 'status' : undefined} data-testid="runs-on-note">{note.text}</div>
    </div>
  );
}

export function RunsOn({ slug, canEdit, placement, onChange }: { slug: string; canEdit: boolean; placement: Placement; onChange: (next: Placement) => void }) {
  const id = useId();
  const q = useQuery(`team-runners:${slug}`, () => fetchTeamRunners(slug));
  const runners: ReadonlyArray<TeamBotRunner> = q.status === 'ok' ? q.data.items : [];
  const listedDefault = runners.find((r) => r.isDefault) ?? null;
  // a default that is off or cannot run bots is not shown as the default: bots that name no runner then run on the host
  const defaultRunner = listedDefault !== null && defaultApplies(listedDefault) ? listedDefault : null;
  const defaultIgnored = listedDefault !== null && defaultRunner === null;
  const chosenName = placement?.runs_on;
  const chosen = chosenName === undefined ? defaultRunner : (runners.find((r) => r.name === chosenName) ?? null);
  const old = oldPlacement(placement);

  if (hasOldPlacement(placement)) {
    const target = moveTarget(runners);
    return (
      <div className="b-fld" data-testid="old-placement">
        <div className="b-fld-lab" id={`${id}-old`}>Old placement</div>
        <div className="b-old" role="group" aria-labelledby={`${id}-old`}>
          {old.map((o) => (
            <div className="b-old-row" key={o.label}>
              <span className="b-old-lab">{o.label}</span>
              <span className="mono" data-testid="old-placement-value">{o.value}</span>
            </div>
          ))}
        </div>
        <div className="b-hint">This bot was placed before runners existed. It keeps working here; moving it to a runner lets an admin manage where it runs.</div>
        {canEdit ? (
          <div className="b-old-act">
            <button
              type="button"
              className="btn s"
              data-testid="move-to-runner"
              disabled={target === null}
              onClick={() => target && onChange(movedPlacement(placement, target.name))}
            >
              Move to a runner
            </button>
            {q.status === 'error' ? <span className="b-warnline" role="alert">The list of runners could not be read.</span> : null}
            {q.status === 'ok' && target === null ? <span className="b-hint" data-testid="move-none">No runner can take this bot yet. Ask a workspace admin to set one up under Runners.</span> : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (!canEdit) {
    return (
      <div className="b-fld" data-testid="runs-on-readonly">
        <div className="b-fld-lab">Runs on</div>
        <div className="b-runner-readonly" data-testid="runs-on-text">
          {chosen !== null ? <><span aria-hidden="true">{KIND_ICON[chosen.kind]} </span>{chosen.label}</> : (chosenName ?? (q.status === 'ok' ? 'Where it always ran (this server)' : 'Loading…'))}
        </div>
        {chosenName === undefined && defaultIgnored ? <div className="b-hint" data-testid="runs-on-default-ignored">{DEFAULT_CANNOT_RUN}</div> : chosen === null && chosenName === undefined ? null : chosen !== null ? <div className="b-hint">{chosenName === undefined ? 'The workspace default runner. ' : ''}{STATUS_LABEL[chosen.status]}</div> : <div className="b-hint">This runner is not available to the team.</div>}
      </div>
    );
  }

  return (
    <div className="b-fld" data-testid="runs-on">
      <label htmlFor={id}>Runs on</label>
      <select
        id={id}
        data-testid="runs-on-select"
        value={chosenName ?? ''}
        disabled={q.status === 'loading'}
        onChange={(e) => onChange(pickedPlacement(placement, e.target.value))}
      >
        <option value="">{defaultRunner !== null ? `Workspace default · ${defaultRunner.label}` : defaultIgnored ? 'No runner chosen · runs on the host' : 'No runner chosen · runs where it always ran'}</option>
        {runners.map((r) => (
          <option key={r.name} value={r.name} disabled={!canRunBots(r) && r.name !== chosenName}>{optionText(r)}</option>
        ))}
        {chosenName !== undefined && !runners.some((r) => r.name === chosenName) ? <option value={chosenName}>{chosenName} · not available to this team</option> : null}
      </select>
      {q.status === 'error' ? <div className="b-warnline" role="alert">The list of runners could not be read.</div> : null}
      {q.status === 'ok' && runners.length === 0 ? <div className="b-hint" data-testid="runs-on-none">No runner is available to this team yet. Ask a workspace admin to set one up under Runners.</div> : null}
      {chosen !== null ? <ChosenRunner runner={chosen} /> : null}
      {chosenName === undefined && defaultIgnored ? <div className="b-warnline" role="status" data-testid="runs-on-default-ignored">{DEFAULT_CANNOT_RUN}</div> : null}
      {chosenName !== undefined && chosen === null && q.status === 'ok' ? (
        <div className="b-warnline" role="status" data-testid="runs-on-note">This team may not use "{chosenName}", so the bot cannot be saved on it. Pick another runner.</div>
      ) : null}
    </div>
  );
}
