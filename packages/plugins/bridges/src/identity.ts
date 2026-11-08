import type { PluginContext } from '@manythreads/sdk';

// Work package B1 (P16-09, decision D25): proving that a chat user is a person. A code (eight digits, ten minutes, once) is made by `app.bridges_issue_code` for a signed-in person; the person
// sends it to the workspace's bot; `app.bridges_link_identity` (system only) redeems it, with five wrong codes per chat in 15 minutes locking that chat out. `/unlink` in the chat, the
// person's button, an admin and a person leaving all end a link and say `bridges.identity.unlinked`. STUB: no subscription until B1 fills it in.
export function registerIdentity(ctx: PluginContext): void {
  void ctx;
}
