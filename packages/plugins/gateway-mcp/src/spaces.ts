import type { BotRunHandle, PluginContext } from '@manythreads/sdk';

// What a run may read, decided once per tool call (P20-08, D10). A "space" is a person's own Personal space or a team's. The answer comes from the run's own
// row in the database (`app.run_space_context()`, bots migration 0026) and from nothing the bot or the model sends:
//   - a private context (a conversation with a bot, a direct message): the asker's Personal space (when the asker's yes and the bot's definition allow it) and
//     every team the asker can read;
//   - anything else (a team channel, a routine, a webhook): the run's own team only.
// The model's arguments can only narrow this, never widen it: a team it names that is not in the list is refused, and the keys that would name a space
// (`space`, `personId`, ...) are dropped before any tool sees them.

export interface RunSpaces {
  audience: 'personal' | 'team';
  /** The asker's person id when their Personal space is open to this bot right now, else null. */
  personId: string | null;
  /** The teams the run may read; always includes the run's own team. */
  teamIds: string[];
  /** Why Personal is shut (`team_audience`, `no_asker`, `no_personal_space`, `not_requested`, `declined`); null when it is open. */
  personalReason: string | null;
}

type ContextRow = {
  audience: string;
  asker_person_id: string | null;
  personal_allowed: boolean;
  personal_reason: string | null;
  team_ids: string[];
};

/** The spaces of a run, read as the run's reader (the asker, else the bot) so the team list is the asker's own. A run that is over gets its own team and nothing else. */
export async function spacesFor(ctx: PluginContext, run: BotRunHandle): Promise<RunSpaces> {
  const row = await ctx.runs.asReader(run, async (tx) => {
    const res = await tx.query<ContextRow>('SELECT audience, asker_person_id, personal_allowed, personal_reason, team_ids FROM app.run_space_context()');
    return res.rows[0];
  });
  if (!row) return { audience: 'team', personId: null, teamIds: [run.teamId], personalReason: 'team_audience' };
  const teamIds = row.team_ids.includes(run.teamId) ? row.team_ids : [run.teamId, ...row.team_ids];
  return {
    audience: row.audience === 'personal' ? 'personal' : 'team',
    personId: row.personal_allowed ? row.asker_person_id : null,
    teamIds,
    personalReason: row.personal_allowed ? null : (row.personal_reason ?? 'declined'),
  };
}

/** The keys that would name a space. A model may not send them; the platform fills in what is allowed. */
const SPACE_KEYS = ['space', 'spaces', 'personId', 'ownerPersonId'] as const;

/** The tools that look in a team's data and take an optional `teamId`. */
const TEAM_SCOPED_READS: ReadonlySet<string> = new Set(['messages.search', 'files.search', 'knowledge.search', 'meetings.search']);

export type SpacesInput = { ok: true; input: Record<string, unknown> } | { ok: false; code: 'other_space'; message: string };

/**
 * Fits a tool call to the run's spaces: drops the keys that would name a space, refuses a team the run may not read, and fills in the default (the run's own
 * team) for a team-scoped tool in a team context. In a private context a search that names no team looks in every team the asker can read, which the
 * tool's own read policies already bound.
 */
export function withRunSpaces(name: string, rawInput: Record<string, unknown>, spaces: RunSpaces, runTeamId: string): SpacesInput {
  const input: Record<string, unknown> = { ...rawInput };
  for (const key of SPACE_KEYS) delete input[key];
  if (name === 'pages.write' || name === 'proposals.propose') {
    if (typeof input['team'] !== 'string') input['team'] = runTeamId;
    return { ok: true, input };
  }
  if (TEAM_SCOPED_READS.has(name)) {
    const named = input['teamId'];
    if (typeof named === 'string') {
      if (!spaces.teamIds.includes(named)) return { ok: false, code: 'other_space', message: 'You can look only in the places this conversation may read. That team is not one of them.' };
    } else if (spaces.audience === 'team') {
      input['teamId'] = runTeamId;
    }
  }
  return { ok: true, input };
}

// The writes of the workspace Brain (P20-07). The Brain has a seat in EVERY team (so it can post where it is mentioned), which means its own database rights reach
// every team's public channels and pages. A read is safe because it is made as the asker and fitted to `spacesFor`; a write is made as the bot, so the place the model
// names must be the run's own, checked here, one door for every write tool that takes a place from its arguments. A team bot has a seat in its own team only, so the
// database already bounds it and nothing is asked of it.

const CHANNEL_WRITES: ReadonlySet<string> = new Set(['messages.post', 'messages.update']);
const TEAM_WRITES: ReadonlySet<string> = new Set(['pages.write', 'proposals.propose']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WriteRefusal {
  code: 'other_space';
  message: string;
}

/** `null` when the call may go on; a refusal when a workspace bot names a channel or a team that is not the run's own. */
export async function confineRunWrite(ctx: PluginContext, run: BotRunHandle, name: string, input: Record<string, unknown>): Promise<WriteRefusal | null> {
  const isChannel = CHANNEL_WRITES.has(name);
  if (!isChannel && !TEAM_WRITES.has(name)) return null;
  const named = isChannel ? input['channelId'] : input['team'];
  if (typeof named !== 'string' || named === '') return null; // nothing named: the run's own place is the default
  // The scope is read as the system, not as the bot: a workspace bot has no team, so the bots policy hides its own row from it (a read as the bot answered nothing, and
  // "nothing" used to mean "not a workspace bot", which left the Brain's writes unconfined). A bot whose row cannot be read is confined too.
  const scope = (await ctx.db.system(async (sys) => (await sys.query<{ scope: string }>('SELECT scope FROM app.bots WHERE id = $1::uuid', [run.botId])).rows[0]?.scope));
  if (scope === 'team') return null;
  return ctx.runs.asBot(run, async (tx) => {
    if (isChannel) {
      // not a uuid: it names nothing, and the tool's own parser says so
      if (!UUID.test(named)) return null;
      const ok = await tx.query(
        `SELECT 1 FROM app.channels c
          WHERE c.id = $1::uuid
            AND (c.team_id = $2::uuid OR c.id = (SELECT r.channel_id FROM app.bot_runs r WHERE r.id = app.run_id()))`,
        [named, run.teamId],
      );
      return ok.rows.length > 0 ? null : { code: 'other_space', message: 'You can write only in the team this conversation belongs to. That channel is not in it.' };
    }
    const ok = await tx.query('SELECT 1 FROM app.teams t WHERE t.id = $1::uuid AND (t.id::text = $2 OR t.slug = $2)', [run.teamId, named]);
    return ok.rows.length > 0 ? null : { code: 'other_space', message: 'You can write only in the team this conversation belongs to. That team is not it.' };
  });
}
