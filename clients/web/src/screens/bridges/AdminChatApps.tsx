import { PageHeader } from '../../components/PageHeader';

/** Set to true by work package B1 when the admin page for chat apps is built (PLAN Bundle D, P16-09). Until then its entry is not in the settings menu. */
export const ADMIN_CHAT_APPS_READY = false;

/** `/settings/workspace/chat-apps`: per service (Telegram, WhatsApp, Slack, Teams) a switch, the credentials, and health. Work package B1 builds it. */
export function AdminChatApps() {
  return <PageHeader title="Chat apps" description="Coming in this bundle." />;
}
