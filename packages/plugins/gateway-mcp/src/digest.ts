import { createHash } from 'node:crypto';
import type { McpToolDescriptor } from '@manythreads/shared';

// The tools digest (PLAN P14-22): one hash of exactly what `tools/list` answers a bot — the tool names, their descriptions, their input schemas
// and whether each needs a person's approval. It changes when the bot's grants change, when an approval flag on a grant changes, and when a new
// version of the platform adds or rewords a tool; it does not change when nothing a Hermes would read has changed. Two things read it: the event
// stream (a change makes every open stream of the bot send `list_changed`) and the managed pod's profile (the `# manythreads tools:` line).

/** One tool as a bot is offered it, with the part of the decision the wire does not carry as a field. */
export interface OfferedTool {
  descriptor: McpToolDescriptor;
  needsApproval: boolean;
}

/** JSON with every object's keys in order, so the same value always has the same bytes. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Sixty-four hex characters. The order the tools were listed in does not matter. */
export function toolsDigest(offered: readonly OfferedTool[]): string {
  const rows = offered
    .map(({ descriptor, needsApproval }) => ({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      destructive: descriptor.destructive,
      needsApproval,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(canonicalJson(rows), 'utf8').digest('hex');
}
