import type { InboxDropper, PluginContext } from '@manythreads/sdk';

// Work package S2 (P15-11): the `inbox.dropper` provider. It files a finished voice room's notes and transcript into the team's memory inbox as one markdown item with
// origin `meeting`, on behalf of the people who said yes (`dropperIds`), held as `external` when a guest was present. It reuses the inbox's own `dropBytes`, so the hold
// and DLP checks are the ones every drop gets. STUB: refuses until S2.
export function createInboxDropper(ctx: PluginContext): InboxDropper {
  void ctx;
  return {
    id: 'inbox.dropper',
    async drop() {
      throw new Error('Not built yet: the meeting dropper belongs to the notes work package');
    },
  };
}
