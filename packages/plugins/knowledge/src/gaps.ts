import type { MessageProvider, PluginContext, PluginTx } from '@manythreads/sdk';
import { attempt } from './ingest.ts';

// Questions a base could not answer (PLAN P8-08): a bot that answers only from its knowledge bases and finds nothing says so to the person, and the
// question goes to the team's #kb-updates channel so whoever keeps the base can fill the gap. Two steps, because the search tool runs as the person
// who asked (it cannot post to a channel they may not write to, and it must not make them the author of a note):
//   1. `recordGap` (the tool): one line in `knowledge_gaps` per team, question and day;
//   2. `postGaps` (a job, every few minutes): one note per team listing what is open, posted by the platform, then the lines are marked.
// A team with no #kb-updates channel is not an error: the lines are marked `no_channel` and nothing is posted.

export const KB_UPDATES_CHANNEL = 'kb-updates';
export const GAPS_QUEUE = 'knowledge.gaps';
const MAX_LISTED = 10;

/** The question as it is stored and shown: one line, no markup that could ping or format, at most 200 characters. */
export function cleanQuery(query: string): string {
  const printable = [...query].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('');
  return printable.replace(/\s+/g, ' ').replace(/[`<>@\\]/g, '').trim().slice(0, 200);
}

export async function recordGap(tx: PluginTx, gap: { teamId: string; botId: string | null; query: string }): Promise<void> {
  const query = cleanQuery(gap.query);
  if (query.length < 2) return;
  // a refusal (a person who may not write here, a full queue) must not take the search down with it
  await attempt(tx, () =>
    tx.query('INSERT INTO app.knowledge_gaps (workspace_id, team_id, bot_id, query) SELECT t.workspace_id, t.id, $2, $3 FROM app.teams t WHERE t.id = $1 ON CONFLICT DO NOTHING', [gap.teamId, gap.botId, query]),
  );
}

type OpenGap = {
  id: string;
  team_id: string;
  bot_id: string | null;
  query: string;
  bot_slug: string | null;
}

/** Posts what is open in one workspace, one note per team (a message belongs to its channel's workspace, so the transaction is scoped to it). Returns how many lines were marked. */
export async function postGaps(ctx: PluginContext, tx: PluginTx, workspaceId: string): Promise<{ posted: number; skipped: number }> {
  const open = (
    await tx.query<OpenGap>(
      `SELECT g.id, g.team_id, g.bot_id, g.query, b.slug AS bot_slug
         FROM app.knowledge_gaps g LEFT JOIN app.bots b ON b.id = g.bot_id
        WHERE g.posted_at IS NULL AND g.workspace_id = $1 ORDER BY g.team_id, g.created_at, g.id LIMIT 200 FOR UPDATE OF g SKIP LOCKED`,
      [workspaceId],
    )
  ).rows;
  const messages = ctx.providers.get<MessageProvider>('messages');
  const byTeam = new Map<string, OpenGap[]>();
  for (const gap of open) byTeam.set(gap.team_id, [...(byTeam.get(gap.team_id) ?? []), gap]);
  let posted = 0;
  let skipped = 0;
  for (const [teamId, gaps] of byTeam) {
    const ids = gaps.map((g) => g.id);
    const channel = (
      await tx.query<{ id: string }>(`SELECT id FROM app.channels WHERE team_id = $1 AND name = $2 AND kind = 'channel' AND archived_at IS NULL`, [teamId, KB_UPDATES_CHANNEL])
    ).rows[0];
    if (!channel || !messages) {
      if (!messages) continue; // nothing can post here yet: try again next time
      await tx.query(`UPDATE app.knowledge_gaps SET posted_at = now(), outcome = 'no_channel' WHERE id = ANY ($1::uuid[])`, [ids]);
      skipped += ids.length;
      continue;
    }
    const lines = gaps.slice(0, MAX_LISTED).map((g) => `- \`${g.query}\`${g.bot_slug ? ` (asked of ${g.bot_slug})` : ''}`);
    const more = gaps.length > MAX_LISTED ? `\n…and ${String(gaps.length - MAX_LISTED)} more.` : '';
    const body = `Knowledge gap: ${gaps.length === 1 ? 'a question' : `${String(gaps.length)} questions`} the knowledge base could not answer. The bot said so instead of guessing; adding or updating a document would close the gap.\n${lines.join('\n')}${more}`;
    // written by the first bot that asked (the lines name the others); a team whose bots are all gone has nobody to write it
    const author = gaps.find((g) => g.bot_id !== null)?.bot_id ?? null;
    const actorId = author === null ? null : (await tx.query<{ id: string | null }>('SELECT app.knowledge_act_as_bot($1::uuid) AS id', [author])).rows[0]?.id ?? null;
    if (actorId === null) {
      await tx.query(`UPDATE app.knowledge_gaps SET posted_at = now(), outcome = 'no_author' WHERE id = ANY ($1::uuid[])`, [ids]);
      skipped += ids.length;
      continue;
    }
    const asBot: PluginTx = { actor: { kind: 'system', id: actorId, workspaceId }, query: (text, values) => tx.query(text, values) };
    const sent = await attempt(tx, () => messages.post(asBot, { channelId: channel.id, body, skipRefs: true }));
    if (!sent.ok) continue; // the channel refused (archived meanwhile, a limit): the lines stay open for the next pass
    await tx.query(`UPDATE app.knowledge_gaps SET posted_at = now(), outcome = 'posted' WHERE id = ANY ($1::uuid[])`, [ids]);
    posted += ids.length;
  }
  return { posted, skipped };
}
