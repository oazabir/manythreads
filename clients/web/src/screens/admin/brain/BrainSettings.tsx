import { Link } from 'react-router';
import type { BotRunner, BotSummary, LlmAlias } from '@manythreads/shared';
import { fetchLlmAliases, fetchTeams } from '../../../api/endpoints';
import { useQuery } from '../../../app/useQuery';
import { PageHeader } from '../../../components/PageHeader';
import { QueryView } from '../../../components/states';
import { fetchBots } from '../../bots/api';
import { fetchBotRunners } from '../runners/api';
import {
  CONSENT_DEFAULT,
  GUEST_RULE,
  NOT_EDITABLE,
  NOT_SET_UP,
  NO_TEAMS,
  READ_RULES,
  RETIRED_TEAM_BRAINS,
  brainState,
  contextTeam,
  findWorkspaceBrain,
  modelLines,
  reachWords,
  runsOnWords,
  shortSha,
} from './brainWords';

/*
 * Settings → Workspace → Brain (P20-07). The workspace has one Brain; this page shows what the server says about it and the rules it works under. It is read only: the
 * server has no route that changes the workspace Brain, so nothing here is a switch. The Brain belongs to no team, so it is read from the roster of the first live team
 * (`GET /api/teams/:slug/bots` lists it with `scope: 'workspace'`). The runner list and the model names are admin reads the page can lose (a failed read is left out, not
 * an error for the whole page). Only an owner or admin opens the page (`AdminOnly`).
 */

type Loaded = { state: 'no-teams' } | { state: 'no-brain' } | { state: 'ok'; brain: BotSummary; runners: BotRunner[] | null; aliases: LlmAlias[] | null };

export async function loadBrain(): Promise<Loaded> {
  const team = contextTeam((await fetchTeams()).teams);
  if (!team) return { state: 'no-teams' };
  const [bots, runners, aliases] = await Promise.all([
    fetchBots(team.slug),
    fetchBotRunners().then((r) => r.items, () => null),
    fetchLlmAliases().then((r) => r.aliases, () => null),
  ]);
  const brain = findWorkspaceBrain(bots.bots);
  return brain ? { state: 'ok', brain, runners, aliases } : { state: 'no-brain' };
}

export function BrainSettings() {
  const q = useQuery('brain-settings', loadBrain);
  return (
    <>
      <PageHeader title="Brain" description="The one Brain for this workspace: what it is, what it runs on and what it may read." />
      <QueryView q={q}>
        {(data) =>
          data.state === 'ok' ? (
            <BrainFacts brain={data.brain} runners={data.runners} aliases={data.aliases} />
          ) : (
            <section className="block" aria-labelledby="bn-missing" data-testid="brain-missing" data-reason={data.state}>
              <h2 className="bh" id="bn-missing">{data.state === 'no-teams' ? 'No team yet' : 'Not set up yet'}</h2>
              <div className="block-body">
                <p className="d">{data.state === 'no-teams' ? NO_TEAMS : NOT_SET_UP}</p>
              </div>
            </section>
          )
        }
      </QueryView>
      <Rules />
    </>
  );
}

function BrainFacts({ brain, runners, aliases }: { brain: BotSummary; runners: BotRunner[] | null; aliases: LlmAlias[] | null }) {
  const state = brainState(brain);
  const reach = reachWords(brain);
  const models = modelLines(aliases);
  return (
    <>
      <section className="block" aria-labelledby="bn-state" data-testid="brain-state">
        <h2 className="bh" id="bn-state">The Brain</h2>
        <ul className="rows">
          <li className="srow bn-row">
            <div className="bn-main">
              <div><strong data-testid="brain-name">{brain.name}</strong> <span className={`chip ${state.tone}`} data-testid="brain-status" data-status={brain.status}>{state.label}</span></div>
              {brain.role ? <div className="d" data-testid="brain-role">{brain.role}</div> : null}
              <div className="d" data-testid="brain-state-sentence">{state.sentence}</div>
            </div>
          </li>
          <li className="srow bn-row">
            <div className="bn-main">
              <div>Who can ask it</div>
              <div className="d" data-testid="brain-reach">{reach.length > 0 ? reach.join('. ') + '.' : 'Nobody can ask it directly: its definition has no conversation or mention trigger.'}</div>
            </div>
          </li>
          <li className="srow bn-row">
            <div className="bn-main">
              <div>Where it runs</div>
              <div className="d" data-testid="brain-runs-on">{runsOnWords(brain, runners)}</div>
              <div className="d">Each run happens in the team where the question was asked. Agent type: <span className="mono" data-testid="brain-runtime">{brain.runtime}</span>.</div>
            </div>
            <Link className="btn s" to="/settings/workspace/runners" data-testid="brain-runners-link">Runners</Link>
          </li>
          <li className="srow bn-row">
            <div className="bn-main">
              <div>Its definition</div>
              <div className="d">Version <span className="mono" data-testid="brain-sha">{shortSha(brain.definitionSha)}</span>. Shared with every team in the workspace.</div>
            </div>
          </li>
        </ul>
      </section>

      <section className="block" aria-labelledby="bn-model" data-testid="brain-model">
        <h2 className="bh" id="bn-model">Its model</h2>
        {models === null ? (
          <div className="block-body"><p className="d" data-testid="brain-model-unknown">The model names could not be read just now.</p></div>
        ) : (
          <ul className="rows">
            {models.map((m) => (
              <li className="srow bn-row" key={m.name} data-testid="brain-model-row" data-name={m.name}>
                <div className="bn-main">
                  <div><span className="mono">{m.name}</span></div>
                  <div className="d" data-testid="brain-model-bound">{m.bound ? `Answers through ${m.bound}.` : 'Not bound to a model yet, so a question that asks for it fails.'}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="block-body">
          <p className="d">The Brain asks for these two names; the shipped definition lists them. Which model each one means is set on the <Link to="/settings/workspace/llm">LLM page</Link>.</p>
        </div>
      </section>
    </>
  );
}

function Rules() {
  return (
    <>
      <section className="block" aria-labelledby="bn-reads" data-testid="brain-reads">
        <h2 className="bh" id="bn-reads">What it may read</h2>
        <ul className="rows">
          {READ_RULES.map((r) => (
            <li className="srow bn-row" key={r.where} data-testid="brain-read-rule">
              <div className="bn-main">
                <div>{r.where}</div>
                <div className="d">{r.reads}</div>
              </div>
            </li>
          ))}
        </ul>
        <div className="block-body"><p className="d">{GUEST_RULE} The server checks these rules on every tool call; no setting on this page changes them.</p></div>
      </section>

      <section className="block" aria-labelledby="bn-consent" data-testid="brain-consent">
        <h2 className="bh" id="bn-consent">Personal space: the default</h2>
        <div className="block-body">
          <p className="d" data-testid="brain-consent-default">{CONSENT_DEFAULT}</p>
          <p className="d">Each person decides under <Link to="/account/bots" data-testid="brain-consent-link">Account, Bots</Link>.</p>
        </div>
      </section>

      <section className="block" aria-labelledby="bn-old" data-testid="brain-old">
        <h2 className="bh" id="bn-old">The old team Brains</h2>
        <div className="block-body"><p className="d" data-testid="brain-old-text">{RETIRED_TEAM_BRAINS}</p></div>
      </section>

      <p className="d bn-foot" data-testid="brain-read-only">{NOT_EDITABLE}</p>
    </>
  );
}
