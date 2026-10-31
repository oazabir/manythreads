import type { BotSummary, HermesConnection } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { fetchConnections } from '../agents/api';
import { useBotPerms } from './store';

/*
 * What the roster and the sidebar say about a bot's state. "Active" in the data only means the definition is loaded and switched on; it
 * says nothing about whether anything can run it. A Hermes bot runs on the agent connection its BOT.md names (`placement.gateway.connection`),
 * so the connection's last check is the one honest signal the page has: a bot is "ready" only when that check passed, and the words say
 * "not set up" or "not working" when the agent behind it is missing or failed. Where the page cannot know (a person who may not see the
 * team's connections, a bot that runs on the server itself or on a runner, a connection nobody has checked yet) it says "active" and does
 * not draw a green dot.
 */

export type BotAvailabilityTone = 'ready' | 'unchecked' | 'warn' | 'bad' | 'off';
export type BotAvailability = { tone: BotAvailabilityTone; label: string; hint: string };

const WHEN_UNKNOWN = 'Its definition is loaded and switched on.';

export function botAvailability(bot: Pick<BotSummary, 'status' | 'runtime' | 'placement'>, connections: ReadonlyArray<HermesConnection> | null): BotAvailability {
  if (bot.status === 'invalid') return { tone: 'bad', label: 'needs a fix', hint: 'Its BOT.md failed to load. Open the bot to see why.' };
  if (bot.status === 'disabled') return { tone: 'off', label: 'off', hint: 'This bot is switched off.' };
  if (bot.runtime !== 'hermes') return { tone: 'ready', label: 'ready', hint: 'It runs inside the server, with no agent to start.' };
  const name = bot.placement?.gateway?.connection;
  if (name === undefined) {
    const where = bot.placement?.runner !== undefined ? 'on a runner' : 'on the server itself';
    return { tone: 'unchecked', label: 'active', hint: `${WHEN_UNKNOWN} It runs ${where}, and whether that is working is not checked here.` };
  }
  if (connections === null) return { tone: 'unchecked', label: 'active', hint: `${WHEN_UNKNOWN} Only a team lead or workspace admin can see whether its agent is working.` };
  const c = connections.find((x) => x.name === name);
  if (!c) return { tone: 'warn', label: 'agent not set up', hint: `It is placed on the "${name}" connection, and this team has none by that name, so nothing will answer.` };
  if (c.status === 'ok') return { tone: 'ready', label: 'ready', hint: `Its agent connection "${name}" passed its last check.` };
  if (c.status === 'error') return { tone: 'bad', label: 'agent not working', hint: `Its agent connection "${name}" failed its last check. Open Agents to see why.` };
  return { tone: 'unchecked', label: 'active', hint: `${WHEN_UNKNOWN} Its agent connection "${name}" has not been checked yet.` };
}

/** The team's agent connections for the people who may see them (a lead or admin); null for everyone else, and when the server has no such plugin. */
export function useAgentConnections(): ReadonlyArray<HermesConnection> | null {
  const { slug, canEdit } = useBotPerms();
  const q = useQuery<ReadonlyArray<HermesConnection> | null>(`bot-availability:${slug}:${canEdit}`, () =>
    canEdit ? fetchConnections(slug).then((r) => r.items, () => null) : Promise.resolve(null),
  );
  return q.status === 'ok' ? q.data : null;
}
