import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { INBOX_DEFAULT_MAX_BYTES, TeamMemoryInboxConfig } from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';
import { inboxMaxBytes } from './upload.ts';

// What a team's TEAM.md says about its inbox, under `memory.inbox` in the frontmatter (docs/plugins/memory-inbox.md):
//   memory:
//     inbox:
//       review: external          external (the default), all, or none
//       keepOriginals: forever    forever, or a number of days
//       allowEmailFrom: ["@acme.example"]
//       maxBytes: 26214400
// A key that is LEFT OUT means the documented default. A key that is PRESENT but cannot be read (not YAML, `memory` or `inbox` not a mapping, a value
// outside its choices) is not "nothing said": the whole config is read as the strictest answer, `review: all`, and the result says it was unreadable,
// so a typo cannot loosen the team's rules. It never throws.

export interface InboxConfig extends TeamMemoryInboxConfig {
  /** True when something under `memory.inbox` (or the front block itself) was there but could not be read; the values are then the strictest. */
  unreadable: boolean;
}

export const DEFAULT_INBOX_CONFIG: InboxConfig = { review: 'external', keepOriginals: 'forever', allowEmailFrom: [], maxBytes: INBOX_DEFAULT_MAX_BYTES, unreadable: false };
export const UNREADABLE_INBOX_CONFIG: InboxConfig = { ...DEFAULT_INBOX_CONFIG, review: 'all', unreadable: true };

const frontmatterOf = (text: string): string | null => {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? (m[1] as string) : null;
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function readInboxConfig(teamMd: string | null, serverMaxBytes: number = INBOX_DEFAULT_MAX_BYTES): InboxConfig {
  const capped = (c: InboxConfig): InboxConfig => ({ ...c, maxBytes: Math.min(c.maxBytes, serverMaxBytes) });
  if (teamMd === null) return capped(DEFAULT_INBOX_CONFIG);
  const block = frontmatterOf(teamMd);
  if (block === null) return capped(DEFAULT_INBOX_CONFIG);
  let doc: unknown;
  try {
    doc = parseYaml(block, { maxAliasCount: 20 });
  } catch {
    return capped(UNREADABLE_INBOX_CONFIG);
  }
  if (doc === null || doc === undefined) return capped(DEFAULT_INBOX_CONFIG);
  if (!isRecord(doc)) return capped(UNREADABLE_INBOX_CONFIG);
  const memory = doc['memory'];
  if (memory === undefined || memory === null) return capped(DEFAULT_INBOX_CONFIG);
  if (!isRecord(memory)) return capped(UNREADABLE_INBOX_CONFIG);
  const inbox = memory['inbox'];
  if (inbox === undefined || inbox === null) return capped(DEFAULT_INBOX_CONFIG);
  const parsed = TeamMemoryInboxConfig.safeParse(inbox);
  if (!parsed.success) return capped(UNREADABLE_INBOX_CONFIG);
  return capped({ ...parsed.data, unreadable: false });
}

/**
 * The team's inbox settings, read from the TEAM.md at the head of its repo (as the transaction's actor). No repo yet or no TEAM.md: the defaults. A file
 * that cannot be read for any other reason is not "nothing said": the strictest answer stands, like an unreadable block.
 */
export async function loadInboxConfig(ctx: PluginContext, tx: PluginTx, teamId: string): Promise<InboxConfig> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  const serverMax = inboxMaxBytes();
  if (!repo) return readInboxConfig(null, serverMax);
  try {
    const blob = await repo.blob(tx, teamId, 'TEAM.md', 'HEAD', 256 * 1024);
    return readInboxConfig(new TextDecoder().decode(blob.content), serverMax);
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 404) return readInboxConfig(null, serverMax);
    return readInboxConfig('---\n[unreadable\n---\n', serverMax);
  }
}
