import type { PluginEvent, PluginTx } from '@manythreads/sdk';
import {
  ChannelStandupDigestedEvent,
  DndSettings,
  OutOfOffice,
  SaveStandupRequest,
  StandupParams,
  StandupResponse,
  WorkingHours,
  dndState,
  getStandupRoute,
  liveOutOfOffice,
  localClock,
  localDate,
  saveStandupRoute,
  type Standup,
} from '@manythreads/shared';
import { conflict, forbidden, invalid, json, notFound, route } from './http.ts';
import { postChannelMessage, type Deps } from './service.ts';

/*
 * Async stand-ups (P35-09, P18-04). See migration 0023 for the whole rule. The asking job runs every five minutes as the system: for each member of the
 * team whose own working day has started (their time zone and working hours; Monday to Friday from 09:00 when they set none) and who has not been asked
 * today, it either records why they are skipped (out of office, Do not disturb) or opens their conversation with the stand-up bot and posts the questions
 * there as the bot. Their next message in that conversation is the answer (the runtime does not wake the bot for it). The digest goes to the channel at
 * its time, or as soon as every member has been asked and has answered or been skipped; then the bot is woken to put each blocker on the board.
 */

export const STANDUP_QUEUE = 'channels.standup';
const DEFAULT_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
/** An ask is open for an answer this long; after that a message in the conversation is a message to the bot again. */
const ANSWER_WINDOW_HOURS = 20;

const minutesOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const clockOf = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export type StandupDecision = { ask: false } | { ask: true; localDate: string; skipped: null | 'out_of_office' | 'do_not_disturb' };

/** Whether to ask one person now, from their time zone, working hours, out-of-office note and Do not disturb. Pure. */
export function standupDecision(input: { now: Date; zone: string | null; hours: WorkingHours | null; days: readonly number[]; dnd: DndSettings | null; ooo: OutOfOffice | null }): StandupDecision {
  const zone = input.zone ?? 'UTC';
  let clock: { weekday: number; minutes: number };
  try {
    clock = localClock(input.now, zone);
  } catch {
    return { ask: false };
  }
  const iso = clock.weekday === 0 ? 7 : clock.weekday;
  if (!input.days.includes(iso)) return { ask: false };
  const hours = input.hours ?? DEFAULT_HOURS;
  if (!hours.days.includes(clock.weekday)) return { ask: false };
  // from the start of their working day until its end: a person who starts later is asked later, nobody is asked at night
  if (clock.minutes < minutesOf(hours.start) || clock.minutes >= minutesOf(hours.end)) return { ask: false };
  const date = localDate(input.now, zone);
  if (liveOutOfOffice(input.ooo, zone, input.now)) return { ask: true, localDate: date, skipped: 'out_of_office' };
  if (input.dnd && dndState(input.dnd, zone, input.now, false).active) return { ask: true, localDate: date, skipped: 'do_not_disturb' };
  return { ask: true, localDate: date, skipped: null };
}

/** The message that asks. */
export function askText(questions: readonly string[], pulse: boolean, channelName: string): string {
  return [
    `**Stand-up for #${channelName}**`,
    '',
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    ...(pulse ? [`${questions.length + 1}. Last, a number from 1 (rough) to 5 (great) for how your week feels. Only the counts are shown, never who said what.`] : []),
    '',
    `Answer in one message here. It goes into today's digest in #${channelName}.`,
  ].join('\n');
}

/** The pulse in an answer: a 1 to 5 at its very end ("… 4", "… 4/5", "mood: 4"). */
export function pulseOf(answer: string): number | null {
  const m = /(?:^|[^\d])([1-5])\s*(?:\/\s*5)?\s*[.!]?\s*$/.exec(answer.trim());
  return m ? Number(m[1]) : null;
}

/** The digest of one stand-up's undigested asks. Pure. */
export function digestText(input: {
  dateText: string;
  answers: ReadonlyArray<{ name: string; answer: string }>;
  away: ReadonlyArray<{ name: string; why: 'out_of_office' | 'do_not_disturb' }>;
  missing: readonly string[];
  pulses: readonly number[] | null;
}): string {
  const lines = [`**Stand-up · ${input.dateText}** (${input.answers.length} answered)`, ''];
  for (const a of input.answers) {
    lines.push(`**${a.name}**`);
    for (const l of a.answer.split('\n').slice(0, 30)) lines.push(`> ${l}`);
    lines.push('');
  }
  if (input.away.length > 0) lines.push(`Away: ${input.away.map((a) => `${a.name} (${a.why === 'out_of_office' ? 'out of office' : 'do not disturb'})`).join(', ')}`);
  if (input.missing.length > 0) lines.push(`No answer: ${input.missing.join(', ')}`);
  if (input.pulses !== null) {
    if (input.pulses.length === 0) lines.push('Pulse: no numbers given.');
    else {
      const avg = input.pulses.reduce((a, b) => a + b, 0) / input.pulses.length;
      const counts = [5, 4, 3, 2, 1].filter((n) => input.pulses!.includes(n)).map((n) => `${n}: ${input.pulses!.filter((p) => p === n).length}`);
      lines.push(`Pulse (anonymous): ${input.pulses.length} ${input.pulses.length === 1 ? 'answer' : 'answers'}, average ${avg.toFixed(1)} (${counts.join(' · ')})`);
    }
  }
  return lines.join('\n').trim();
}

interface StandupRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  channel_id: string;
  channel_name: string;
  bot_id: string;
  questions: string[];
  pulse: boolean;
  days: number[];
  digest_minute: number;
  last_digest_on: string | null;
}

const STANDUP_SELECT = `SELECT s.id, s.workspace_id, s.team_id, s.channel_id, c.name AS channel_name, s.bot_id, s.questions, s.pulse, s.days, s.digest_minute,
  to_char(s.last_digest_on, 'YYYY-MM-DD') AS last_digest_on FROM app.standups s JOIN app.channels c ON c.id = s.channel_id`;

type BotActor = { bot_id: string; actor_id: string; slug: string };

async function botActor(tx: PluginTx, botId: string): Promise<BotActor | undefined> {
  return (
    await tx.query<BotActor>(
      `SELECT b.id AS bot_id, a.id AS actor_id, b.slug FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id WHERE b.id = $1 AND b.status = 'active'`,
      [botId],
    )
  ).rows[0];
}

/** Posts as the bot from a system transaction: messages need a real author, and a bot outside a run may not read a person's conversation with it. */
async function postAsBot(deps: Deps, workspaceId: string, bot: BotActor, input: Parameters<typeof postChannelMessage>[2]): Promise<string> {
  return deps.ctx.db.system(async (tx) => (await postChannelMessage(deps, tx, { ...input, systemAuthorId: bot.actor_id })).id, { workspaceId });
}

/** One pass of the asking job: who is due their question now. Returns how many were asked and how many skipped. */
export async function standupAskPass(deps: Deps, now: Date = new Date(), log: (line: string) => void = () => undefined): Promise<{ asked: number; skipped: number }> {
  const { ctx } = deps;
  const out = { asked: 0, skipped: 0 };
  const standups = await ctx.db.system(async (tx) => (await tx.query<StandupRow>(`${STANDUP_SELECT} WHERE s.enabled AND c.archived_at IS NULL ORDER BY s.id LIMIT 200`)).rows);
  for (const s of standups) {
    const work = await ctx.db.system(
      async (tx) => {
        const bot = await botActor(tx, s.bot_id);
        if (!bot) return null;
        const members = (
          await tx.query<{ actor_id: string; person_id: string; time_zone: string | null; working_hours: unknown; ooo_active: boolean | null; ooo_returns_on: string | null; ooo_message: string | null; dnd_enabled: boolean | null; dnd_paused_until: Date | null; dnd_schedule: unknown }>(
            `SELECT a.id AS actor_id, a.ref_id AS person_id, ps.time_zone, ps.working_hours, ps.ooo_active, to_char(ps.ooo_returns_on, 'YYYY-MM-DD') AS ooo_returns_on, ps.ooo_message,
                    d.enabled AS dnd_enabled, d.paused_until AS dnd_paused_until, d.schedule AS dnd_schedule
               FROM app.team_members tm
               JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person'
               JOIN app.people p ON p.id = a.ref_id AND p.status = 'active'
               LEFT JOIN app.person_status ps ON ps.person_id = p.id
               LEFT JOIN app.dnd_settings d ON d.person_id = p.id
              WHERE tm.team_id = $1
                AND NOT EXISTS (SELECT 1 FROM app.standup_asks k WHERE k.standup_id = $2 AND k.person_id = p.id AND k.asked_at > now() - interval '${ANSWER_WINDOW_HOURS} hours')`,
            [s.team_id, s.id],
          )
        ).rows;
        return { bot, members };
      },
      { workspaceId: s.workspace_id },
    );
    if (!work) continue;
    for (const m of work.members) {
      const hours = WorkingHours.safeParse(m.working_hours);
      const dnd = m.dnd_enabled === null ? null : DndSettings.safeParse({ enabled: m.dnd_enabled, pausedUntil: m.dnd_paused_until?.toISOString() ?? null, schedule: m.dnd_schedule });
      const decision = standupDecision({
        now,
        zone: m.time_zone,
        hours: hours.success ? hours.data : null,
        days: s.days,
        dnd: dnd?.success ? dnd.data : null,
        ooo: m.ooo_active ? OutOfOffice.parse({ active: true, returnsOn: m.ooo_returns_on, delegatePersonId: null, message: m.ooo_message ?? '' }) : null,
      });
      if (!decision.ask) continue;
      // claim the day first (a second pass, or another replica, finds the row and does nothing), then open the conversation and ask
      const claimed = await ctx.db.system(
        async (tx) => {
          const row = (
            await tx.query<{ id: string }>(
              `INSERT INTO app.standup_asks (standup_id, workspace_id, person_id, local_date, skipped) VALUES ($1, $2, $3, $4::date, $5)
               ON CONFLICT (standup_id, person_id, local_date) DO NOTHING RETURNING id`,
              [s.id, s.workspace_id, m.person_id, decision.localDate, decision.skipped],
            )
          ).rows[0];
          if (!row || decision.skipped) return row ? { id: row.id, conversation: null } : null;
          // the person's conversation with the bot, as `app.conversations_open` makes it when they open it themselves
          const conversation = (
            await tx.query<{ id: string }>(
              `INSERT INTO app.channels AS c (workspace_id, team_id, name, kind, private, bot_id, created_by) VALUES ($1, $2, '', 'bot_conversation', true, $3, $4)
               ON CONFLICT (workspace_id, bot_id, created_by) WHERE kind = 'bot_conversation' DO SELECT RETURNING c.id`,
              [s.workspace_id, s.team_id, work.bot.bot_id, m.actor_id],
            )
          ).rows[0]!.id;
          await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [conversation, m.person_id]);
          await tx.query('UPDATE app.standup_asks SET conversation_id = $2 WHERE id = $1', [row.id, conversation]);
          return { id: row.id, conversation };
        },
        { workspaceId: s.workspace_id },
      );
      if (!claimed) continue;
      if (!claimed.conversation) {
        out.skipped += 1;
        continue;
      }
      try {
        const question = await postAsBot(deps, s.workspace_id, work.bot, { channelId: claimed.conversation, body: askText(s.questions, s.pulse, s.channel_name), threadRootId: null, meta: { standupAsk: claimed.id } });
        await ctx.db.system((tx) => tx.query('UPDATE app.standup_asks SET question_message_id = $2, asked_at = now() WHERE id = $1', [claimed.id, question]), { workspaceId: s.workspace_id });
        out.asked += 1;
      } catch (err) {
        // the question could not be posted (the bot lost its team, the channel went): the claim goes, so the next pass tries again
        log(`stand-up ${s.id}: the question could not be posted: ${err instanceof Error ? err.message : String(err)}`);
        await ctx.db.system((tx) => tx.query('DELETE FROM app.standup_asks WHERE id = $1', [claimed.id]), { workspaceId: s.workspace_id });
      }
    }
  }
  return out;
}

/** One pass of the digest: each stand-up whose digest is due posts it. Returns how many digests were posted. */
export async function standupDigestPass(deps: Deps, now: Date = new Date()): Promise<number> {
  const { ctx } = deps;
  let posted = 0;
  const today = now.toISOString().slice(0, 10);
  const nowMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const standups = await ctx.db.system(async (tx) => (await tx.query<StandupRow>(`${STANDUP_SELECT} WHERE s.enabled AND c.archived_at IS NULL ORDER BY s.id LIMIT 200`)).rows);
  for (const s of standups) {
    const facts = await ctx.db.system(
      async (tx) => {
        const asks = (
          await tx.query<{ id: string; person_id: string; name: string; skipped: 'out_of_office' | 'do_not_disturb' | null; answer: string | null; pulse: number | null; question_message_id: string | null }>(
            `SELECT k.id, k.person_id, coalesce(p.display_name, 'Someone') AS name, k.skipped, k.answer, k.pulse, k.question_message_id
               FROM app.standup_asks k JOIN app.people p ON p.id = k.person_id
              WHERE k.standup_id = $1 AND k.digested_at IS NULL AND (k.skipped IS NOT NULL OR k.question_message_id IS NOT NULL)
              ORDER BY k.answered_at NULLS LAST, p.display_name`,
            [s.id],
          )
        ).rows;
        const members = Number(
          (
            await tx.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' JOIN app.people p ON p.id = a.ref_id AND p.status = 'active' WHERE tm.team_id = $1`,
              [s.team_id],
            )
          ).rows[0]?.n ?? '0',
        );
        return { asks, members, bot: await botActor(tx, s.bot_id) };
      },
      { workspaceId: s.workspace_id },
    );
    if (!facts.bot || facts.asks.length === 0) continue;
    const answered = facts.asks.filter((a) => a.answer !== null);
    const everyone = facts.asks.length >= facts.members && facts.asks.every((a) => a.answer !== null || a.skipped !== null);
    const atTime = nowMinute >= s.digest_minute && (s.last_digest_on === null || s.last_digest_on < today);
    if (!everyone && !atTime) continue;
    const body = digestText({
      dateText: now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
      answers: answered.map((a) => ({ name: a.name, answer: a.answer! })),
      away: facts.asks.filter((a) => a.skipped !== null).map((a) => ({ name: a.name, why: a.skipped! })),
      missing: facts.asks.filter((a) => a.answer === null && a.skipped === null).map((a) => a.name),
      pulses: s.pulse ? answered.map((a) => a.pulse).filter((p): p is number => p !== null) : null,
    });
    let digestId: string;
    try {
      digestId = await postAsBot(deps, s.workspace_id, facts.bot, { channelId: s.channel_id, body, threadRootId: null, meta: { standupDigest: s.id } });
    } catch {
      continue;
    }
    await ctx.db.system(
      async (tx) => {
        await tx.query('UPDATE app.standup_asks SET digested_at = now(), digest_message_id = $2 WHERE id = ANY($1::uuid[])', [facts.asks.map((a) => a.id), digestId]);
        await tx.query('UPDATE app.standups SET last_digest_on = $2::date WHERE id = $1', [s.id, today]);
        if (answered.length > 0) {
          await ctx.audit.emit(
            tx,
            ChannelStandupDigestedEvent.parse({
              type: 'channel.standup.digested',
              schemaVersion: 1,
              workspaceId: s.workspace_id,
              teamId: s.team_id,
              standupId: s.id,
              channelId: s.channel_id,
              digestMessageId: digestId,
              botId: s.bot_id,
              answered: answered.length,
            }),
          );
        }
      },
      { workspaceId: s.workspace_id },
    );
    posted += 1;
  }
  return posted;
}

/**
 * A message in a bot conversation answers the stand-up asked there, when one is open: the person's first message after the question, within the window.
 * A late answer (after the digest) is added under the digest. Returns whether the message was an answer.
 */
export async function recordStandupAnswer(deps: Deps, tx: PluginTx, messageId: string): Promise<boolean> {
  const m = (
    await tx.query<{ id: string; channel_id: string; body_plain: string; author_id: string; kind: string; created_by: string | null; thread_root_id: string | null }>(
      `SELECT m.id, m.channel_id, m.body_plain, m.author_id, c.kind, c.created_by, m.thread_root_id FROM app.messages m JOIN app.channels c ON c.id = m.channel_id WHERE m.id = $1 AND m.deleted_at IS NULL`,
      [messageId],
    )
  ).rows[0];
  if (!m || m.kind !== 'bot_conversation' || m.author_id !== m.created_by || m.thread_root_id !== null || m.body_plain.trim() === '') return false;
  const ask = (
    await tx.query<{ id: string; standup_id: string; workspace_id: string; digest_message_id: string | null; channel_id: string; bot_id: string; person_name: string }>(
      `UPDATE app.standup_asks k SET answer = left($2, 4000), answer_message_id = $3, answered_at = now(), pulse = $4
         FROM app.standups s, app.people p
        WHERE k.id = (SELECT k2.id FROM app.standup_asks k2 JOIN app.messages q ON q.id = k2.question_message_id
                       WHERE k2.conversation_id = $1 AND k2.answered_at IS NULL AND k2.skipped IS NULL AND k2.asked_at > now() - interval '${ANSWER_WINDOW_HOURS} hours'
                         AND q.id < $3 ORDER BY k2.asked_at DESC LIMIT 1)
          AND s.id = k.standup_id AND p.id = k.person_id
       RETURNING k.id, k.standup_id, k.workspace_id, k.digest_message_id, s.channel_id, s.bot_id, coalesce(p.display_name, 'Someone') AS person_name`,
      [m.channel_id, m.body_plain, m.id, pulseOf(m.body_plain)],
    )
  ).rows[0];
  if (!ask) return false;
  if (ask.digest_message_id) {
    const bot = await botActor(tx, ask.bot_id);
    if (bot) {
      const lines = m.body_plain.split('\n').slice(0, 30).map((l) => `> ${l}`);
      await postChannelMessage(deps, tx, { channelId: ask.channel_id, threadRootId: ask.digest_message_id, body: [`**${ask.person_name}** (late)`, ...lines].join('\n'), systemAuthorId: bot.actor_id });
    }
  }
  return true;
}

const toStandup = (s: StandupRow & { enabled: boolean; bot_slug: string }): Standup => ({
  enabled: s.enabled,
  botSlug: s.bot_slug,
  questions: s.questions,
  pulse: s.pulse,
  days: s.days,
  digestAt: clockOf(s.digest_minute),
});

export function registerStandups(deps: Deps): void {
  const { ctx } = deps;

  ctx.http.route({
    ...getStandupRoute,
    schema: { response: StandupResponse },
    handler: route(async (req, tx) => {
      const { channelId } = StandupParams.parse(req.params);
      const channel = (await tx.query<{ kind: string }>('SELECT kind FROM app.channels WHERE id = $1', [channelId])).rows[0];
      if (!channel) throw notFound('No such channel');
      const canManage = (await tx.query<{ ok: boolean }>(`SELECT coalesce(app.lookup_channel_can($1, 'manage'), false) AS ok`, [channelId])).rows[0]?.ok === true;
      const row = (
        await tx.query<StandupRow & { enabled: boolean; bot_slug: string }>(
          `SELECT s.id, s.workspace_id, s.team_id, s.channel_id, '' AS channel_name, s.bot_id, s.questions, s.pulse, s.days, s.digest_minute, NULL AS last_digest_on, s.enabled,
                  coalesce((SELECT b.slug FROM app.bots b WHERE b.id = s.bot_id), '') AS bot_slug
             FROM app.standups s WHERE s.channel_id = $1`,
          [channelId],
        )
      ).rows[0];
      return json(StandupResponse.parse({ standup: row ? toStandup(row) : null, canManage }));
    }),
  });

  ctx.http.route({
    ...saveStandupRoute,
    schema: { body: SaveStandupRequest, response: StandupResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = StandupParams.parse(req.params);
      const body = SaveStandupRequest.parse(req.body);
      const channel = (await tx.query<{ kind: string; team_id: string | null; workspace_id: string; archived_at: Date | null }>('SELECT kind, team_id, workspace_id, archived_at FROM app.channels WHERE id = $1', [channelId])).rows[0];
      if (!channel) throw notFound('No such channel');
      if (channel.kind !== 'channel' || !channel.team_id) throw invalid('A stand-up runs in a channel of a team');
      if (channel.archived_at) throw conflict('This channel is archived');
      const canManage = (await tx.query<{ ok: boolean }>(`SELECT coalesce(app.lookup_channel_can($1, 'manage'), false) AS ok`, [channelId])).rows[0]?.ok === true;
      if (!canManage) throw forbidden('Only a team lead or a workspace admin can set up a stand-up');
      const bot = (await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE team_id = $1 AND slug = $2 AND status = 'active'`, [channel.team_id, body.botSlug])).rows[0];
      if (!bot) throw invalid(`botSlug: the team has no active bot called "${body.botSlug}"`);
      await tx.query(
        `INSERT INTO app.standups (workspace_id, team_id, channel_id, bot_id, enabled, questions, pulse, days, digest_minute, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8::smallint[], $9, app.actor())
         ON CONFLICT (channel_id) DO UPDATE SET bot_id = EXCLUDED.bot_id, enabled = EXCLUDED.enabled, questions = EXCLUDED.questions, pulse = EXCLUDED.pulse,
                days = EXCLUDED.days, digest_minute = EXCLUDED.digest_minute, updated_at = now()`,
        [channel.workspace_id, channel.team_id, channelId, bot.id, body.enabled, body.questions, body.pulse, [...new Set(body.days)].sort(), minutesOf(body.digestAt)],
      );
      return json(StandupResponse.parse({ standup: { ...body, days: [...new Set(body.days)].sort() }, canManage: true }));
    }),
  });

  // a person's message in a bot conversation may answer a stand-up asked there
  ctx.events.subscribe('channel.message.posted', async (raw: PluginEvent, tx: PluginTx) => {
    const messageId = (raw as { messageId?: unknown }).messageId;
    if (typeof messageId !== 'string') return;
    await recordStandupAnswer(deps, tx, messageId);
  });

  ctx.jobs.register(
    STANDUP_QUEUE,
    async (_payload, _tx, job) => {
      await standupAskPass(deps, new Date(), (line) => job.log.warn(line));
      await standupDigestPass(deps);
    },
    { cron: '*/5 * * * *', maxAttempts: 1, concurrency: 1, detached: true },
  );
}

