import type { PluginContext } from '@manythreads/sdk';

// Work package A (P16-11, decisions D32 to D35): removing a leaving person's connections. When `workspace.member.status_changed` says a person is suspended (or an admin presses the
// button) their own connections are disabled at once, a job asks each provider to forget the grant and deletes the sealed tokens, and the team and workspace connections they set up
// move to the team's longest-serving lead (`app.connections_offboard_start`, system only). STUB: nothing is subscribed and no job exists until A fills it in.
export function registerOffboard(ctx: PluginContext): void {
  void ctx;
}
