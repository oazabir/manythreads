import { PageHeader } from '../../components/PageHeader';

/** Set to true by work package B1 when the person's chat-apps page is built (PLAN Bundle D, P16-09). Until then its entry is not in the account menu. */
export const ACCOUNT_CHAT_APPS_READY = false;

/** `/account/chat-apps`: link or unlink your own Telegram, WhatsApp, Slack or Teams user with a code. Work package B1 builds it. */
export function AccountChatApps() {
  return <PageHeader title="Chat apps" description="Coming in this bundle." />;
}
