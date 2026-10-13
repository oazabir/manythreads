import { Link } from 'react-router';
import type { BotSummary } from '@manythreads/shared';
import { QueryView } from '../../components/states';
import { Avatar } from '../../components/ui';
import { useHeaderTopic } from '../../shell/topic';
import { useBots } from './store';

/*
 * The team's bot roster (SPEC §7.5, `[proto §02 plate 5 · Bots — the roster]`): the Bots header in the sidebar opens it. Every bot
 * with its kind, runtime and placement, its state, and the two things a person does from here — open its conversation (phase 5's
 * conversations plugin) and configure it. A bot whose definition failed to load says so on its own row, so the roster is also where
 * the alert is noticed without opening the page.
 *
 * Where a bot runs is `placement` — open data the loader validated (PLAN D3): `node` or `runner`, the prototype's "build-01" /
 * "pool=teams". A definition that names neither runs anywhere in the team's pool.
 */

const placeOf = (bot: BotSummary): string => {
  const p = bot.placement;
  if (!p) return 'any node';
  if (typeof p.node === 'string') return p.node;
  if (typeof p.runner === 'string') return p.runner;
  return 'any node';
};

/** The state dot of the prototype: busy is a bot with a live run (phase 5 runs arrive with the gateway); idle and off are the rest. */
function State({ bot }: { bot: BotSummary }) {
  if (bot.status === 'invalid') return <span className="b-state bad"><span className="dot bad" aria-hidden="true" />needs a fix</span>;
  if (bot.status === 'disabled') return <span className="b-state off"><span className="dot off" aria-hidden="true" />off</span>;
  return <span className="b-state"><span className="dot up" aria-hidden="true" />idle</span>;
}

function Row({ bot, slug }: { bot: BotSummary; slug: string }) {
  return (
    <div className="b-row" data-testid="bot-row" data-bot={bot.slug}>
      <Avatar name={bot.name} kind={bot.kind === 'automation' ? 'automation' : 'agent'} />
      <div className="b-who">
        <div className="b-name">
          <Link to={`/t/${slug}/bots/${bot.slug}`} data-testid="bot-open">{bot.name}</Link>
        </div>
        <div className="d">{bot.role || 'No role written yet.'}</div>
      </div>
      <div><span className={`kind ${bot.kind === 'automation' ? 'ru' : 'ag'}`}>{bot.kind}</span></div>
      <div className="mono b-where">{bot.runtime === 'hermes' ? `Hermes · ${placeOf(bot)}` : `Rules · ${placeOf(bot)}`}</div>
      <div className="b-vis">{bot.visibility === 'workspace' ? 'shared with the workspace' : 'this team'}</div>
      <div><State bot={bot} /></div>
      <div className="b-act">
        {bot.status === 'active' ? <Link className="btn s" to={`/t/${slug}/bots/${bot.slug}/chat`} data-testid="bot-talk">Talk</Link> : null}
        <Link className="btn s" to={`/t/${slug}/bots/${bot.slug}?tab=identity`} data-testid="bot-configure">Configure</Link>
      </div>
    </div>
  );
}

export function BotRoster() {
  const { slug, q } = useBots();
  useHeaderTopic('Bots');
  return (
    <div className="bots-screen" data-testid="bots-roster">
      <QueryView q={q}>
        {({ bots }) => {
          const agents = bots.filter((b) => b.kind === 'agent').length;
          const automations = bots.length - agents;
          return (
            <>
              <div className="b-head">
                <div>
                  <h2 className="b-title">Bots</h2>
                  <p className="b-sub" data-testid="roster-count">
                    {bots.length === 0
                      ? 'No bots yet.'
                      : `${bots.length} ${bots.length === 1 ? 'bot' : 'bots'} · ${agents} ${agents === 1 ? 'agent' : 'agents'}, ${automations} ${automations === 1 ? 'automation' : 'automations'}`}
                  </p>
                </div>
              </div>
              {bots.length === 0 ? (
                <div className="b-empty" data-testid="roster-empty">
                  <p className="b-empty-title">No bots yet</p>
                  <p className="b-empty-body">
                    A bot is a folder in the team repo: <span className="mono">bots/&lt;slug&gt;/BOT.md</span>. Add one from a team template, or write the file
                    in Files — a valid definition appears here within seconds.
                  </p>
                  <Link className="btn primary" to={`/t/${slug}/files?path=bots`}>Open bots/ in Files</Link>
                </div>
              ) : (
                <div className="b-list" data-landmark="bot-roster">
                  {bots.map((b) => <Row key={b.id} bot={b} slug={slug} />)}
                </div>
              )}
            </>
          );
        }}
      </QueryView>
    </div>
  );
}