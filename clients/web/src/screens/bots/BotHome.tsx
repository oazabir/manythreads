import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import type { BotSummary } from '@manythreads/shared';
import { QueryView } from '../../components/states';
import { PageHeader } from '../../components/PageHeader';
import { useCrumbTail } from '../../shell/topic';
import { GearIcon } from '../../shell/icons';
import { botChatPath, botSettingsPath } from './botPaths';
import { useBot } from './store';

/*
 * `/t/<team>/bots/<bot>`: the way in from the sidebar (P29-13). A bot that allows chatting opens its chat. One that does not says so, in one line of why, with a "Bot settings"
 * button for the people who may change the bot's settings (the team's leads and workspace admins: the same rule the settings routes enforce) and none for anyone else.
 * An old address with `?tab=` meant the settings page: it goes there.
 */

/** Does the bot allow a one-to-one chat: it is on, and its definition lists a `conversation` trigger (the API answers 409 for anything else). */
export const allowsChat = (bot: Pick<BotSummary, 'status' | 'conversational'>): boolean => bot.status === 'active' && bot.conversational;

/** One line of why there is no chat. */
export function whyNoChat(bot: Pick<BotSummary, 'status' | 'conversational' | 'name'>): string {
  if (bot.status === 'disabled') return `${bot.name} is turned off.`;
  if (bot.status === 'invalid') return `${bot.name}'s file has a mistake, so it is not running.`;
  return `${bot.name} works on mentions, schedules or events and has no one-to-one chat.`;
}

export function NoChat({ bot, team, canEdit }: { bot: BotSummary; team: string; canEdit: boolean }) {
  return (
    <div className="bh-empty" data-testid="bot-no-chat" data-bot={bot.slug}>
      <PageHeader
        inline
        title={`No chat is available with ${bot.name}.`}
        testIds={{ title: 'bot-no-chat-title', description: 'bot-no-chat-why' }}
        description={whyNoChat(bot)}
        actions={canEdit ? (
          <Link className="btn primary bh-settings" to={botSettingsPath(team, bot.slug)} data-testid="bot-settings-button">
            <GearIcon />
            <span>Bot settings</span>
          </Link>
        ) : undefined}
      />
      {canEdit ? null : <p className="view-empty-body" data-testid="bot-no-chat-who">A team lead or a workspace admin can change this bot.</p>}
    </div>
  );
}

export function BotHome() {
  const { team = '', botSlug = '' } = useParams();
  const [params] = useSearchParams();
  const { slug, canEdit, q } = useBot(botSlug);
  useCrumbTail(q.status === 'ok' ? q.data.bot.name : null);
  const tab = params.get('tab');
  // an old address for the settings page (`?tab=...`) goes where the settings are now
  if (tab !== null) return <Navigate to={botSettingsPath(team, botSlug, tab)} replace />;
  return (
    <div className="bot-screen" data-testid="bot-home">
      <QueryView q={q}>
        {(data) => (allowsChat(data.bot) ? <Navigate to={botChatPath(slug || team, data.bot.slug)} replace /> : <NoChat bot={data.bot} team={slug || team} canEdit={canEdit} />)}
      </QueryView>
    </div>
  );
}
