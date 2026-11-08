/** Set to true by work package B1 when the "Chat apps" tab of the Integrations dialog is built (PLAN Bundle D, P16-09). Until then the tab is not drawn. */
export const CHAT_BRIDGE_TAB_READY = false;

/** Join this public channel to a Telegram, WhatsApp, Slack or Teams chat with a code. Work package B1 builds it. */
export function ChatBridgeTab({ channelId, channelName }: { channelId: string; channelName: string }) {
  void [channelId, channelName];
  return null;
}
