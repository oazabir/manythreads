import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Link } from 'react-router';
import type { BotSummary, HermesConnection } from '@manythreads/shared';
import { QueryView } from '../../components/states';
import { Avatar } from '../../components/ui';
import { useSession } from '../../app/session';
import { BotWorkingIcon, GearIcon } from '../../shell/icons';
import { useNarrow } from '../../shell/useNarrow';
import { useQuery } from '../../app/useQuery';
import { fetchProposals } from '../proposals/api';
import { botAvailability, useAgentConnections } from './availability';
import { useBots } from './store';
import { MoreMenu } from './MoreMenu';

/*
 * The team's bot roster (SPEC §7.5, `[proto §02 plate 5 · Bots — the roster]`): the Bots header in the sidebar opens it. Every bot
 * with its runtime, its state (and, only when they differ from the default, a chip for an automation, a fixed place or a bot shared with the
 * workspace), and the two things a person does from here — open its conversation (phase 5's
 * conversations plugin) and configure it. A bot whose definition failed to load says so on its own row, so the roster is also where
 * the alert is noticed without opening the page.
 *
 * Where a bot runs is `placement` — open data the loader validated (PLAN D3): `node` or `runner`, the prototype's "build-01" /
 * "pool=teams". A definition that names neither runs anywhere in the team's pool.
 */

const placeOf = (bot: BotSummary): string => {
  const p = bot.placement;
  if (!p) return 'any node';
  if (typeof p.runs_on === 'string') return p.runs_on;
  if (typeof p.node === 'string') return p.node;
  if (typeof p.runner === 'string') return p.runner;
  return 'any node';
};

/** The state dot of the prototype, from `botAvailability`: green only when the bot's agent passed its last check; "active" with an open ring when the page cannot tell. */
function State({ bot, connections }: { bot: BotSummary; connections: ReadonlyArray<HermesConnection> | null }) {
  const a = botAvailability(bot, connections);
  return (
    <span className={`b-state ${a.tone}`} title={a.hint} data-testid="bot-state" data-state={a.tone}>
      <span className={`dot ${a.tone}`} aria-hidden="true" />{a.label}
    </span>
  );
}

/** The quiet words of a bot with no 1:1 chat: visible text, and the same reason in `title` for a longer read. */
const NO_TALK = 'This bot has no one-to-one chat; it works when something triggers it.';

function Row({ bot, slug, connections }: { bot: BotSummary; slug: string; connections: ReadonlyArray<HermesConnection> | null }) {
  const place = placeOf(bot);
  // a bot with no conversation trigger has no 1:1 chat: the Talk button is not drawn at all (the API refuses it too)
  const canTalk = bot.status === 'active' && bot.conversational;
  return (
    <div className="b-row" data-testid="bot-row" data-bot={bot.slug}>
      <Avatar name={bot.name} kind={bot.kind === 'automation' ? 'automation' : 'agent'} avatar={bot.avatar} />
      <div className="b-who">
        <div className="b-name">
          <Link to={`/t/${slug}/bots/${bot.slug}`} data-testid="bot-open">{bot.name}</Link>
        </div>
        <div className="d">{bot.role || 'No role written yet.'}</div>
        {/* a chip says what is not the default: an automation, a fixed place, a bot shared across teams */}
        <div className="b-meta">
          <span className="b-rt">{bot.runtime === 'hermes' ? 'Hermes' : 'Rules'}</span>
          {bot.kind === 'automation' ? <span className="kind ru" data-testid="bot-chip-kind">automation</span> : null}
          {place !== 'any node' ? <span className="b-tag mono" title="Where this bot runs" data-testid="bot-chip-place">{place}</span> : null}
          {bot.visibility === 'workspace' ? <span className="b-tag" title="Every team in the workspace can use this bot" data-testid="bot-chip-scope">Shared with the workspace</span> : null}
        </div>
      </div>
      <div className="b-statecell"><State bot={bot} connections={connections} /></div>
      <div className="b-act">
        {canTalk ? (
          <Link className="btn primary s" to={`/t/${slug}/bots/${bot.slug}/chat`} data-testid="bot-talk">Talk</Link>
        ) : bot.status === 'active' ? (
          <span className="b-bg" title={NO_TALK} data-testid="bot-background">Runs in the background</span>
        ) : null}
        <Link className="icon-btn" to={`/t/${slug}/bots/${bot.slug}?tab=identity`} aria-label={`Configure ${bot.name}`} title={`Configure ${bot.name}`} data-testid="bot-configure">
          <GearIcon />
        </Link>
      </div>
    </div>
  );
}

/** How many proposals wait: changes to bots/ and the other guarded places go through them. */
function useWaitingProposals(slug: string): number | null {
  const q = useQuery(`proposals-count:${slug}`, () => fetchProposals(slug, 'open'));
  return q.status === 'ok' ? q.data.openCount : null;
}

const proposalsLabel = (n: number | null): string => `Proposals${n !== null && n > 0 ? ` (${n} waiting)` : ''}`;

/** The header's way to the other bot screens: three links on a desktop, one "More" menu on a phone. */
function HeaderLinks({ slug }: { slug: string }) {
  const narrow = useNarrow();
  const waiting = useWaitingProposals(slug);
  if (narrow) {
    return (
      <MoreMenu
        label="More"
        testId="roster-more"
        items={[
          { to: `/t/${slug}/recipes`, label: 'Browse recipes', testId: 'roster-recipes' },
          { to: `/t/${slug}/proposals`, label: proposalsLabel(waiting), testId: 'roster-proposals' },
          { to: `/t/${slug}/agents`, label: 'Agents', testId: 'roster-agents' },
        ]}
      />
    );
  }
  return (
    <>
      <Link className="btn s ag-roster-link" to={`/t/${slug}/recipes`} data-testid="roster-recipes">Browse recipes</Link>
      <Link className="btn s ag-roster-link" to={`/t/${slug}/proposals`} data-testid="roster-proposals">{proposalsLabel(waiting)}</Link>
      <Link className="btn s ag-roster-link" to={`/t/${slug}/agents`} data-testid="roster-agents">Agents</Link>
    </>
  );
}

export function BotRoster() {
  const { slug, q } = useBots();
  const connections = useAgentConnections();
  // a guest has no team to set a bot up for: no way in for them
  const guest = useSession().role === 'guest';
  const count = q.status === 'ok' ? q.data.bots : null;
  const agentCount = count?.filter((b) => b.kind === 'agent').length ?? 0;
  const autoCount = (count?.length ?? 0) - agentCount;
  return (
    <div className="bots-screen" data-testid="bots-roster">
      <PageHeader
        title="Bots"
        testIds={{ description: 'roster-count' }}
        description={count === null ? undefined : count.length === 0
          ? 'No bots yet.'
          : `${count.length} ${count.length === 1 ? 'bot' : 'bots'} · ${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}, ${autoCount} ${autoCount === 1 ? 'automation' : 'automations'}`}
        actions={(
          <>
            {guest ? null : <Link className="btn primary" to={`/t/${slug}/bots/new`} data-testid="roster-add-bot">Add a bot</Link>}
            <HeaderLinks slug={slug} />
          </>
        )}
      />
      <QueryView q={q}>
        {({ bots }) => {
          return (
            <>
              {bots.length === 0 ? (
                <EmptyState
                  icon={BotWorkingIcon}
                  testId="roster-empty"
                  title="No bots yet"
                  {...(guest ? {} : { action: { label: 'Add a bot', to: `/t/${slug}/bots/new` } })}
                >
                  Each bot is described in a file the team can review. Describe what you want and a helper drafts it for
                  you to approve, or propose the file yourself in Files. Once a workspace admin applies it, the bot appears here within seconds.
                  <br />
                  <Link to={`/t/${slug}/recipes`} data-testid="roster-empty-recipes">Browse recipes</Link> or <Link to={`/t/${slug}/files?path=bots`}>open the bots in Files</Link>.
                </EmptyState>
              ) : (
                <div className="b-list" data-landmark="bot-roster">
                  <div className="b-heads" aria-hidden="true">
                    <span className="b-h-bot">Bot</span>
                    <span>State</span>
                    <span />
                  </div>
                  {bots.map((b) => <Row key={b.id} bot={b} slug={slug} connections={connections} />)}
                </div>
              )}
            </>
          );
        }}
      </QueryView>
    </div>
  );
}