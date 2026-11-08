/** Set to true by work package H when the "Work apps" tab of the Integrations dialog is built (PLAN Bundle D, P16-10). Until then the tab is not drawn. */
export const PROVIDER_HOOKS_TAB_READY = false;

/** The addresses a work app (GitHub, GitLab, Jira, Linear, Zendesk, Intercom, HubSpot, Asana, or any sender) calls for this channel. Work package H builds it. */
export function ProviderHooksTab({ channelId }: { channelId: string }) {
  void channelId;
  return null;
}
