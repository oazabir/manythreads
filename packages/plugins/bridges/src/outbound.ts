import type { PluginContext } from '@manythreads/sdk';

// Work package B1 (P16-09, decisions D26, D27): what leaves. A consumer of `channel.message.posted` queues one `bridge_messages` row per linked chat for a public channel's message that did not itself
// come across the same bridge (the loop guard is `meta.via`); a job sends it as "Name: text" (4000 characters, attachments as links) through the one outbound door: the host is a constant per
// service (a Teams service address only from the Microsoft list), no redirects, ten seconds, a 256 KB answer, the `pre_egress` chain with destination `bridge`, three tries with backoff, then dead.
// WhatsApp answers only within 24 hours of the person's last message; a later one waits. STUB: nothing is subscribed until B1 fills it in.
export function registerOutbound(ctx: PluginContext): void {
  void ctx;
}
