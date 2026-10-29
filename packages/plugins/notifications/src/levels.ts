import type { PluginTx } from '@manythreads/sdk';
import { DEFAULT_WORKSPACE_LEVEL, NotificationLevel, defaultLevelFor, firstWordOf, matchKeywords, wordsOf } from '@manythreads/shared';

/** The level team channels start with in a workspace (`mentions` until an admin changes it). */
export async function workspaceDefaultLevel(tx: PluginTx, workspaceId: string): Promise<NotificationLevel> {
  const res = await tx.query<{ default_level: string }>('SELECT default_level FROM app.notification_workspace_settings WHERE workspace_id = $1::uuid', [workspaceId]);
  const parsed = NotificationLevel.safeParse(res.rows[0]?.default_level);
  return parsed.success ? parsed.data : DEFAULT_WORKSPACE_LEVEL;
}

/**
 * The members of a channel whose level is "all messages": their own choice, or the default for this kind of channel where they made none.
 * Only people who joined the channel (a membership row) are listed; the consumer still checks that each can read it.
 */
export async function membersHearingAll(tx: PluginTx, channelId: string, channelKind: string, workspaceDefault: NotificationLevel): Promise<string[]> {
  const res = await tx.query<{ person_id: string }>(
    `SELECT cm.person_id
       FROM app.channel_members cm
       LEFT JOIN app.notification_levels nl ON nl.person_id = cm.person_id AND nl.channel_id = cm.channel_id
      WHERE cm.channel_id = $1::uuid AND coalesce(nl.level, $2) = 'all'`,
    [channelId, defaultLevelFor(channelKind, workspaceDefault)],
  );
  return res.rows.map((r) => r.person_id);
}

/** The most distinct words of a message handed to the database to find keyword candidates. */
const CANDIDATE_WORDS_MAX = 500;

/**
 * Who has a keyword in this text: for each member of the channel with a keyword that appears as a whole word (any case), the first such keyword.
 * The database narrows by the first word of each keyword (an indexed equality); the whole phrase is then checked here.
 */
export async function keywordMatches(tx: PluginTx, channelId: string, text: string): Promise<Map<string, string>> {
  const words = [...new Set(wordsOf(text))].slice(0, CANDIDATE_WORDS_MAX);
  const found = new Map<string, string>();
  if (words.length === 0) return found;
  const candidates = await tx.query<{ person_id: string; keyword: string }>(
    `SELECT k.person_id, k.keyword
       FROM app.notification_keywords k
       JOIN app.channel_members cm ON cm.channel_id = $1::uuid AND cm.person_id = k.person_id
      WHERE k.first_word = ANY ($2::text[])
      ORDER BY k.person_id, k.keyword`,
    [channelId, words],
  );
  const byPerson = new Map<string, string[]>();
  for (const r of candidates.rows) {
    if (firstWordOf(r.keyword) === '') continue;
    byPerson.set(r.person_id, [...(byPerson.get(r.person_id) ?? []), r.keyword]);
  }
  for (const [personId, keywords] of byPerson) {
    const hit = matchKeywords(text, keywords)[0];
    if (hit !== undefined) found.set(personId, hit);
  }
  return found;
}
