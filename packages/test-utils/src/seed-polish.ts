import { createSystemPool, withSystem } from '@manythreads/kernel';
import { AnswerPayload, BOT_ANIMAL_AVATAR_PRESETS, toPlainText } from '@manythreads/shared';
import type { TestDatabase } from './db.ts';
import { KAHF_WORKSPACE_ID, personas, TEAM_IDS, type Persona } from './personas.ts';
import { seedUuid } from './seed-content.ts';

/**
 * Seed v21 (PLAN P21-24, owner decision B17): a channel for the look checks of Phase 21, in the Engineering team. OPT-IN: nothing calls this from
 * `seedWorld`, so the default world and every existing visual baseline stay exactly as they were. Only the polish visual specs and the message-run
 * specs ask for it (the e2e stack with `MANYTHREADS_STACK_SEED=polish`, or a script calling `seedPolish(db)`).
 *
 * `#polish` holds what the new look has to get right and the default seed has too little of:
 *  - a run of 12 short messages by Nadia inside five minutes (one avatar and name, then continued lines: the density check);
 *  - one message of 40 lines (cut to four with "Show more");
 *  - an Answer by the coder bot with three citations of messages in the channel;
 *  - a thread with Omar, Nadia and Rafi: a root and six replies.
 *
 * Needs seed v3 (the channel tables) and, for the Answer, seed v4 (the `coder` bot placeholder, made into a bot row by the bots plugin a moment after
 * the repository is committed: it is waited for), which also gets a fixed picture (the loader's is a random animal, different on every stack, so it could not
 * be in a baseline). Idempotent: fixed ids, `ON CONFLICT DO NOTHING`, the times are fixed once by the first run.
 */
export const SEED_POLISH = {
  channel: { id: '00000000-0000-7000-8000-0000000f0051', name: 'polish', team: 'engineering', purpose: 'A place to check how the look holds up: a run of messages, a long one, an answer and a thread.' },
  /** The run, the long message, the answer, and the thread. Ids carry the seed's own sequence numbers. */
  runLength: 12,
  longLines: 40,
  threadReplies: 6,
  citations: 3,
  /** The bot whose Answer is posted (a seed v4 placeholder). */
  bot: 'coder',
  runId: '00000000-0000-7000-8000-0000000f0061',
} as const;

const MIN = 60_000;
const CHANNEL_NO = 51;
/** With `MANYTHREADS_CLOCK=fixed` the channel starts on the Monday after the default content's ten working days, so a plate says the same date every time. */
const FIXED_START_MS = Date.UTC(2026, 2, 16, 9, 0, 0);

export interface SeedPolishOptions {
  /** How long to wait for the `coder` bot row (default 30 s). */
  botWaitMs?: number;
  /** The instant of the first message; default 60 minutes ago, floored to the minute (the newest message is then a little under 40 minutes old); with MANYTHREADS_CLOCK=fixed a fixed Monday in March 2026. */
  baseDate?: Date;
  log?: (line: string) => void;
}

export interface SeedPolishResult {
  /** Why nothing was written (the channel tables are not there yet), or null. */
  skipped: string | null;
  messages: number;
  /** True when the Answer was posted (the coder bot was there). */
  answer: boolean;
  notes: string[];
}

const RUN_LINES = [
  'Morning. I looked at the deploy checklist.',
  'Step one is still the cache flush.',
  'Step two moved after the health check.',
  'I added the rollback command under it.',
  'The canary now runs for thirty minutes.',
  'Nothing else changed in the list.',
  'The staging run was green at nine.',
  'The second run was green too.',
  'I will post the diff in a minute.',
  'Here it is: two lines added, one removed.',
  'Review it when you have a minute.',
  'I am off to lunch after this one.',
];

const longMessage = (): string =>
  [
    'Release notes draft for v2.14, please read it all before the review:',
    ...Array.from({ length: SEED_POLISH.longLines - 1 }, (_, i) => `${i + 1}. ${LONG_ITEMS[i % LONG_ITEMS.length]} (item ${i + 1})`),
  ].join('\n');

const LONG_ITEMS = [
  'The cache keeps a response for sixty seconds instead of five minutes',
  'The canary stays at ten percent for thirty minutes before the rollout',
  'A rollback command is printed at the end of every deploy',
  'The health check waits for two good answers in a row',
  'Staging is rebuilt from scratch every night',
];

const THREAD: Array<{ who: 'omar' | 'nadia' | 'rafi'; text: string }> = [
  { who: 'omar', text: 'Can we ship the new cache time on Thursday?' },
  { who: 'nadia', text: 'Yes, the checks pass and the rollback is ready.' },
  { who: 'rafi', text: 'I would wait for the second staging run first.' },
  { who: 'omar', text: 'Fair. When does that run finish?' },
  { who: 'rafi', text: 'About four in the afternoon.' },
  { who: 'nadia', text: 'Then Thursday morning works for me.' },
  { who: 'omar', text: 'Thursday morning it is.' },
];

export async function seedPolish(db: Pick<TestDatabase, 'systemUrl'>, options: SeedPolishOptions = {}): Promise<SeedPolishResult> {
  const log = options.log ?? (() => undefined);
  const result: SeedPolishResult = { skipped: null, messages: 0, answer: false, notes: [] };
  const pool = createSystemPool(db.systemUrl, 2);
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    const ws = KAHF_WORKSPACE_ID;
    const team = TEAM_IDS.Engineering;
    const actor = (p: Persona): string => p.actorId;

    // The bot of the Answer: waited for, since the bots plugin makes its row from the repository seed a moment after the commit.
    const findBot = (): Promise<{ id: string; actorId: string } | null> =>
      withSystem(
        async (tx) => {
          const row = (
            await tx.query<{ id: string; actor_id: string | null }>(
              `SELECT b.id, a.id AS actor_id FROM app.bots b
                 LEFT JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id AND a.workspace_id = b.workspace_id
                WHERE b.team_id = $1 AND b.slug = $2`,
              [team, SEED_POLISH.bot],
            )
          ).rows[0];
          return row?.actor_id ? { id: row.id, actorId: row.actor_id } : null;
        },
        { pool, workspaceId: ws },
      );
    let bot = await findBot();
    for (const deadline = Date.now() + (options.botWaitMs ?? 30_000); !bot && Date.now() < deadline; ) {
      await sleep(1000);
      bot = await findBot();
    }
    if (!bot) result.notes.push(`the ${SEED_POLISH.bot} bot is not loaded: the Answer was left out (run seed v4 first)`);
    // The loader gives a new bot a random animal; a picture that differs from one stack to the next cannot be in a baseline, so the bot gets the first one.
    if (bot) {
      const botId = bot.id;
      await withSystem(async (tx) => void (await tx.query(`UPDATE app.bots SET avatar = $2 WHERE id = $1`, [botId, `preset:${BOT_ANIMAL_AVATAR_PRESETS[0]!.id}`])), { pool, workspaceId: ws });
    }

    await withSystem(
      async (tx) => {
        const ready = (await tx.query<{ ok: boolean }>(`SELECT to_regclass('app.channels') IS NOT NULL AND to_regclass('app.messages') IS NOT NULL AS ok`)).rows[0]?.ok;
        if (!ready) {
          result.skipped = 'the channels tables are not there yet (start the server once so its plugin migrations run, then seed again)';
          return;
        }
        const group = (await tx.query<{ id: string }>(`SELECT id FROM app.channel_groups WHERE team_id = $1 AND name = 'Channels'`, [team])).rows[0]?.id ?? null;
        await tx.query(
          `INSERT INTO app.channels (id, workspace_id, team_id, group_id, name, kind, private, purpose, position, created_by)
           VALUES ($1, $2, $3, $4, $5, 'channel', false, $6, 91, $7)
           ON CONFLICT (team_id, name) WHERE kind = 'channel' DO NOTHING`,
          [SEED_POLISH.channel.id, ws, team, group, SEED_POLISH.channel.name, SEED_POLISH.channel.purpose, actor(personas.omar)],
        );
        const channel = (await tx.query<{ id: string }>(`SELECT id FROM app.channels WHERE team_id = $1 AND name = $2 AND kind = 'channel'`, [team, SEED_POLISH.channel.name])).rows[0]!.id;
        for (const p of [personas.omar, personas.nadia, personas.rafi, personas.priya]) {
          await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [channel, p.personId]);
        }

        // Times. A message id carries its time (uuidv7), created_at carries the same instant.
        const start = Math.floor((options.baseDate?.getTime() ?? (process.env['MANYTHREADS_CLOCK'] === 'fixed' ? FIXED_START_MS : Date.now() - 60 * MIN)) / MIN) * MIN;
        let seq = 0;
        interface Row { id: string; who: string; text: string; at: number; root: string | null; meta: Record<string, unknown> }
        const rows: Row[] = [];
        const add = (who: string, text: string, atMs: number, root: string | null = null, meta: Record<string, unknown> = {}): Row => {
          seq += 1;
          const row = { id: seedUuid(atMs, 700 + seq, CHANNEL_NO), who, text, at: atMs, root, meta };
          rows.push(row);
          return row;
        };

        // The thread first (an hour-old question), then the run, the long message, the Answer.
        const root = add(actor(personas.omar), THREAD[0]!.text, start);
        const replies = THREAD.slice(1).map((t, i) => add(actor(personas[t.who]), t.text, start + (i + 1) * 2 * MIN, root.id));
        const runStart = start + 20 * MIN;
        const run = RUN_LINES.slice(0, SEED_POLISH.runLength).map((text, i) => add(actor(personas.nadia), text, runStart + i * 20_000));
        const long = add(actor(personas.rafi), longMessage(), start + 30 * MIN);

        let answerRow: Row | null = null;
        if (bot) {
          const pick = [run[0]!, run[3]!, long];
          const payload = AnswerPayload.parse({
            version: 1,
            body: 'The checklist changed in three places [1][2]: the rollback command was added under step two, and the release notes list the rest [3].',
            citations: pick.map((m, i) => ({
              kind: 'message',
              n: i + 1,
              label: toPlainText(m.text).replace(/\s+/g, ' ').trim().slice(0, 80),
              scope: 'team',
              messageId: m.id,
              channelId: channel,
              teamId: team,
              channelKind: 'channel',
              channelName: SEED_POLISH.channel.name,
              threadRootId: null,
            })),
            lineage: pick.map((m, i) => ({
              n: i + 1,
              kind: 'message',
              label: toPlainText(m.text).replace(/\s+/g, ' ').trim().slice(0, 80),
              at: new Date(m.at).toISOString(),
              snippet: toPlainText(m.text).replace(/\s+/g, ' ').trim().slice(0, 120),
            })),
            sourcesReached: [],
            outsideScope: { count: 0, items: [] },
            answeredFor: { personId: personas.nadia.personId, name: personas.nadia.name, scope: 'scoped', alias: 'smart', botId: bot.id, runId: SEED_POLISH.runId },
            chips: [{ kind: 'followup', label: 'What did the release notes add?', prompt: 'What did the release notes add?' }],
          });
          answerRow = add(bot.actorId, payload.body, start + 34 * MIN, null, { answer: payload });
        }

        const ordered = [...rows].sort((a, b) => a.at - b.at);
        const inserted = await tx.query(
          `INSERT INTO app.messages (id, workspace_id, channel_id, author_id, body, body_plain, thread_root_id, meta, created_at)
           SELECT x.id, $1::uuid, $2::uuid, x.author_id, x.body, x.plain, x.root_id, x.meta::jsonb, x.created_at
             FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::uuid[], $8::text[], $9::timestamptz[])
                  AS x(id, author_id, body, plain, root_id, meta, created_at)
           ON CONFLICT (id) DO NOTHING`,
          [
            ws, channel,
            // roots before replies is guaranteed by the sort: a reply is always later than its root
            ordered.map((r) => r.id),
            ordered.map((r) => r.who),
            ordered.map((r) => r.text),
            ordered.map((r) => toPlainText(r.text)),
            ordered.map((r) => r.root),
            ordered.map((r) => JSON.stringify(r.meta)),
            ordered.map((r) => new Date(r.at).toISOString()),
          ],
        );
        result.messages = inserted.rowCount ?? 0;
        result.answer = answerRow !== null;

        // Read state: everybody who joined has read the channel to its last top-level message, and the thread's people follow it to its last reply.
        const lastTop = ordered.filter((r) => r.root === null).at(-1)!;
        for (const p of [personas.omar, personas.nadia, personas.rafi, personas.priya]) {
          await tx.query(
            `INSERT INTO app.read_state (person_id, target_type, target_id, last_read_id, unread_count) VALUES ($1, 'channel', $2, $3, 0) ON CONFLICT DO NOTHING`,
            [p.personId, channel, lastTop.id],
          );
        }
        const lastReply = replies[replies.length - 1]!;
        for (const p of [personas.omar, personas.nadia, personas.rafi]) {
          await tx.query(
            `INSERT INTO app.read_state (person_id, target_type, target_id, last_read_id, unread_count, followed) VALUES ($1, 'thread', $2, $3, 0, true)
             ON CONFLICT (person_id, target_type, target_id) DO UPDATE SET last_read_id = EXCLUDED.last_read_id, unread_count = 0 WHERE app.read_state.last_read_id IS NULL`,
            [p.personId, root.id, lastReply.id],
          );
        }
      },
      { pool, workspaceId: ws },
    );
  } finally {
    await pool.end();
  }
  if (result.skipped) log(`polish skipped: ${result.skipped}`);
  else log(`polish: #${SEED_POLISH.channel.name} with ${result.messages} new messages${result.answer ? ' and an Answer' : ' (no Answer: ' + (result.notes[0] ?? 'no bot') + ')'}`);
  return result;
}
