import type { PluginContext } from '@manythreads/sdk';

// Work package D2 (P16-08, decisions D12, D13, D15): reading a connector source. It rides inside the existing `knowledge.sync` pass (connector sources share its five-sources-a-pass budget, and
// the pass is detached so a long read holds no connection): ask the `connector.documents` provider (looked up when needed, never in `register`) what changed under the source's root since
// its cursor, take at most 100 documents and 20 MB a pass, fetch each changed one with the source's grant, apply the access rule for a team base, convert and index it, remove what was removed,
// store the new cursor and say `knowledge.source.synced` with counts. A grant that is gone pauses the source. STUB: reads nothing until D2 fills it in.
export function registerConnectorSync(ctx: PluginContext): void {
  void ctx;
}
