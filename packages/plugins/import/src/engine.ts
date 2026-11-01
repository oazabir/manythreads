import type { ImportedChannel, MessageProvider, MessagePosted, PluginTx } from '@manythreads/sdk';
import { importChannelName, type ImportProgress, type ImportReport, type ImportSkipReason, type ImportSource } from '@manythreads/shared';
import { BATCH_SIZE } from './limits.ts';
import type { ArchiveChannel, ArchiveMessage, ArchivePerson, ArchiveReader } from './model.ts';
import { Tally, buildReport } from './report.ts';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// The import itself. One function, `runImport`, serves both the dry run and the real run, so the report of the first is a promise the second keeps:
// the same archive goes through the same decisions, and only the writes differ. It talks to the database in short transactions (`transaction`), never
// holding one while it reads the archive, and writes only through the channels plugin's message provider and the one direct-conversation function.

export type Transaction = <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>;

export interface RunInput {
  mode: 'dry' | 'real';
  transaction: Transaction;
  provider: MessageProvider;
  reader: ArchiveReader;
  runId: string;
  workspaceId: string;
  source: ImportSource;
  teamId: string;
  /** The actor of the admin who started the import: the creator of the channels. */
  startedBy: string;
  /** How many messages the dry run counted, for the progress bar. */
  expectedMessages?: number;
  onProgress?: (tx: PluginTx, progress: ImportProgress) => Promise<void>;
  /** Runs inside each batch's transaction; true stops the import after that batch. */
  shouldStop?: (tx: PluginTx) => Promise<boolean>;
  now?: () => Date;
}

export interface RunOutcome {
  report: ImportReport;
  cancelled: boolean;
}

type Resolution =
  | { kind: 'matched'; personId: string; actorId: string; onTeam: boolean }
  | { kind: 'placeholder'; actorId: string | null; email: string | null };

type Plan = {
  channel: ArchiveChannel;
  outcome: 'create' | 'exists' | 'skip';
  reason: ImportSkipReason | null;
  becomes: string | null;
  targetId: string | null;
  /** For a private channel: the person ids to add. For a direct conversation: the people in it. */
  memberPersonIds: string[];
  /** For a direct conversation: the actors allowed to write in it. */
  memberActorIds: Set<string>;
  messages: number;
};

const isoOf = (ms: number): string => new Date(ms).toISOString();

/** The messages already written for these archive keys (and still existing), by key. */
async function lookupMessages(tx: PluginTx, workspaceId: string, source: string, keys: readonly string[]): Promise<Map<string, { target: string; runId: string | null }>> {
  const out = new Map<string, { target: string; runId: string | null }>();
  if (keys.length === 0) return out;
  const res = await tx.query<{ source_id: string; target_id: string; run_id: string | null }>(
    `SELECT m.source_id, m.target_id, m.run_id FROM app.import_map m JOIN app.messages x ON x.id = m.target_id
      WHERE m.workspace_id = $1 AND m.source = $2 AND m.kind = 'message' AND m.source_id = ANY ($3::text[])`,
    [workspaceId, source, keys],
  );
  for (const r of res.rows) out.set(r.source_id, { target: r.target_id, runId: r.run_id });
  return out;
}

/** People of the archive against the people here: matched by a verified email address, else a placeholder (made now in a real run). */
async function resolvePeople(input: RunInput, tally: Tally, people: ArchivePerson[]): Promise<Map<string, Resolution>> {
  const { transaction, workspaceId, source, teamId } = input;
  const out = new Map<string, Resolution>();
  const humans = people.filter((p) => !p.isBot);
  tally.people.total = humans.length;
  const emails = [...new Set(humans.map((p) => p.email).filter((e): e is string => e !== null))];
  for (let i = 0; i < humans.length; i += 500) {
    const slice = humans.slice(i, i + 500);
    const sliceEmails = emails.filter((e) => slice.some((p) => p.email === e));
    await transaction(async (tx) => {
      const matched = new Map<string, { personId: string; actorId: string; onTeam: boolean }>();
      if (sliceEmails.length > 0) {
        const res = await tx.query<{ email: string; person_id: string; actor_id: string; on_team: boolean }>(
          `SELECT lower(e.email) AS email, p.id AS person_id, a.id AS actor_id,
                  EXISTS (SELECT 1 FROM app.team_members tm WHERE tm.team_id = $3 AND tm.actor_id = a.id) AS on_team
             FROM app.person_emails e
             JOIN app.people p ON p.id = e.person_id AND p.workspace_id = e.workspace_id AND p.status = 'active'
             JOIN app.actors a ON a.kind = 'person' AND a.ref_id = p.id AND a.workspace_id = p.workspace_id
            WHERE e.workspace_id = $1 AND e.verified_at IS NOT NULL AND lower(e.email) = ANY ($2::text[])`,
          [workspaceId, sliceEmails, teamId],
        );
        for (const r of res.rows) matched.set(r.email, { personId: r.person_id, actorId: r.actor_id, onTeam: r.on_team });
      }
      // a placeholder from an earlier run: claimed (the person has it now) or still waiting
      const known = await tx.query<{ source_id: string; actor_id: string; claimed_by: string | null; claimed_actor: string | null; claimed_on_team: boolean | null }>(
        `SELECT ip.source_id, ip.actor_id, ip.claimed_by, ca.id AS claimed_actor,
                CASE WHEN ca.id IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM app.team_members tm WHERE tm.team_id = $4 AND tm.actor_id = ca.id) END AS claimed_on_team
           FROM app.import_people ip
           LEFT JOIN app.actors ca ON ca.kind = 'person' AND ca.ref_id = ip.claimed_by AND ca.workspace_id = ip.workspace_id
          WHERE ip.workspace_id = $1 AND ip.source = $2 AND ip.source_id = ANY ($3::text[])`,
        [workspaceId, source, slice.map((p) => p.key), teamId],
      );
      const byKey = new Map(known.rows.map((r) => [r.source_id, r]));
      for (const p of slice) {
        const prior = byKey.get(p.key);
        if (prior?.claimed_by && prior.claimed_actor) {
          out.set(p.key, { kind: 'matched', personId: prior.claimed_by, actorId: prior.claimed_actor, onTeam: prior.claimed_on_team === true });
          continue;
        }
        const hit = p.email ? matched.get(p.email) : undefined;
        if (hit) {
          out.set(p.key, { kind: 'matched', ...hit });
          continue;
        }
        if (prior) {
          out.set(p.key, { kind: 'placeholder', actorId: prior.actor_id, email: p.email });
          continue;
        }
        if (input.mode === 'real') out.set(p.key, { kind: 'placeholder', actorId: await ensurePlaceholder(tx, workspaceId, source, p.key, p.name, p.email), email: p.email });
        else out.set(p.key, { kind: 'placeholder', actorId: null, email: p.email });
      }
    });
  }
  for (const p of humans) {
    const r = out.get(p.key)!;
    if (r.kind === 'matched') {
      tally.people.matched += 1;
      if (!r.onTeam) tally.people.matchedNotOnTeam += 1;
    } else {
      tally.people.placeholders += 1;
      if (p.email === null) tally.people.withoutEmail += 1;
    }
  }
  return out;
}

/**
 * A stand-in for someone without an account here: an actor the messages are written as, and the row that says whose it is. The row is looked up first (the
 * archive may name this person again on a later batch, a retry or a second run, and `import_people` holds one row per person); a stand-in that has been
 * claimed since answers with the person's own actor.
 */
async function ensurePlaceholder(tx: PluginTx, workspaceId: string, source: string, key: string, name: string, email: string | null): Promise<string> {
  const have = (
    await tx.query<{ actor_id: string; claimed_actor: string | null }>(
      `SELECT ip.actor_id, ca.id AS claimed_actor
         FROM app.import_people ip
         LEFT JOIN app.actors ca ON ca.kind = 'person' AND ca.ref_id = ip.claimed_by AND ca.workspace_id = ip.workspace_id
        WHERE ip.workspace_id = $1 AND ip.source = $2 AND ip.source_id = $3`,
      [workspaceId, source, key],
    )
  ).rows[0];
  if (have) return have.claimed_actor ?? have.actor_id;
  const id = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
  const actor = (
    await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('system', $1, $2) RETURNING id", [workspaceId, id])
  ).rows[0]!.id;
  await tx.query(
    `INSERT INTO app.import_people (id, workspace_id, source, source_id, name, email, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, workspaceId, source, key, name.slice(0, 200) || key, email, actor],
  );
  return actor;
}

/** The key under which a channel or message is remembered: a direct conversation belongs to its people, anything else to the team it was made in. */
const mapKey = (teamId: string, kind: ArchiveChannel['kind'], key: string): string => (kind === 'direct' ? key : `${teamId}/${key}`);

/** The name a channel is made with: its own, or its short name / id when its own has no letter or digit that a channel name can keep (Arabic, Chinese). */
export const channelBaseName = (c: ArchiveChannel): string => (/[a-z0-9]/.test(c.name.normalize('NFKD').toLowerCase()) || !c.slug ? c.name : c.slug);

/** Decides what each channel of the archive becomes. Reads only. */
async function planChannels(input: RunInput, tally: Tally, channels: ArchiveChannel[], people: Map<string, Resolution>): Promise<Plan[]> {
  const { transaction, workspaceId, source, teamId } = input;
  const mapped = new Map<string, string>();
  const taken = new Set<string>();
  await transaction(async (tx) => {
    const res = await tx.query<{ kind: string; source_id: string; target_id: string }>(
      `SELECT m.kind, m.source_id, m.target_id FROM app.import_map m JOIN app.channels c ON c.id = m.target_id
        WHERE m.workspace_id = $1 AND m.source = $2 AND m.kind IN ('channel', 'direct') AND m.source_id = ANY ($3::text[])`,
      [workspaceId, source, channels.map((c) => mapKey(teamId, c.kind, c.key))],
    );
    for (const r of res.rows) mapped.set(r.source_id, r.target_id);
    const names = await tx.query<{ name: string }>('SELECT lower(name) AS name FROM app.channels WHERE team_id = $1', [teamId]);
    for (const r of names.rows) taken.add(r.name);
  });
  tally.channels.total = channels.length;
  const plans: Plan[] = [];
  for (const channel of channels) {
    if (channel.kind === 'public') tally.channels.public += 1;
    else if (channel.kind === 'private') tally.channels.private += 1;
    else tally.channels.direct += 1;
    const plan: Plan = { channel, outcome: 'create', reason: null, becomes: null, targetId: mapped.get(mapKey(teamId, channel.kind, channel.key)) ?? null, memberPersonIds: [], memberActorIds: new Set(), messages: 0 };
    if (channel.kind === 'direct') {
      const matched = (channel.memberKeys ?? []).map((k) => people.get(k)).filter((r): r is Extract<Resolution, { kind: 'matched' }> => r?.kind === 'matched');
      const wanted = new Set(channel.memberKeys ?? []).size;
      const distinct = new Map(matched.map((r) => [r.personId, r]));
      if (wanted < 2 || distinct.size !== wanted || wanted > 9) {
        plan.outcome = 'skip';
        plan.reason = 'dm_not_matched';
      } else {
        plan.memberPersonIds = [...distinct.keys()];
        plan.memberActorIds = new Set([...distinct.values()].map((r) => r.actorId));
      }
    } else if (channel.kind === 'private') {
      if (channel.memberKeys === null) {
        plan.outcome = 'skip';
        plan.reason = 'private_channel_unknown_members';
      } else {
        const ids = new Set<string>();
        for (const k of channel.memberKeys) {
          const r = people.get(k);
          if (r?.kind === 'matched' && r.onTeam) ids.add(r.personId);
        }
        plan.memberPersonIds = [...ids];
        if (ids.size === 0) {
          plan.outcome = 'skip';
          plan.reason = 'channel_without_members';
        }
      }
    }
    if (plan.outcome === 'create') {
      if (plan.targetId) plan.outcome = 'exists';
      else if (channel.kind !== 'direct') {
        const base = importChannelName(channelBaseName(channel));
        let name = base;
        for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
        taken.add(name);
        plan.becomes = name;
      }
    }
    if (plan.outcome === 'skip') {
      tally.channels.skipped += 1;
      tally.skip(plan.reason!);
    } else tally.channels.imported += 1;
    plans.push(plan);
  }
  return plans;
}

/** Real run: make the channels and direct conversations the plan says to make, and remember which is which. */
async function createChannels(input: RunInput, plans: Plan[]): Promise<void> {
  const { transaction, workspaceId, source, runId, teamId, startedBy, provider } = input;
  for (const plan of plans) {
    if (plan.outcome !== 'create') continue;
    await transaction(async (tx) => {
      const kind = plan.channel.kind;
      let channelId: string;
      if (kind === 'direct') {
        const first = [...plan.memberActorIds][0]!;
        await tx.query('SELECT app.import_act_as($1)', [first]);
        const res = await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.dms_get_or_create($1::uuid[])', [plan.memberPersonIds]);
        channelId = res.rows[0]!.channel_id;
      } else {
        await tx.query('SELECT app.import_act_as($1)', [startedBy]);
        const made: ImportedChannel = await provider.importChannel(tx, {
          teamId,
          name: channelBaseName(plan.channel),
          private: kind === 'private',
          purpose: plan.channel.purpose,
          memberPersonIds: plan.memberPersonIds,
        });
        channelId = made.channelId;
        plan.becomes = made.name;
      }
      await tx.query(
        `INSERT INTO app.import_map (workspace_id, source, kind, source_id, target_id, run_id) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, source, kind, source_id) DO UPDATE SET target_id = EXCLUDED.target_id, run_id = EXCLUDED.run_id`,
        [workspaceId, source, kind === 'direct' ? 'direct' : 'channel', mapKey(teamId, kind, plan.channel.key), channelId, runId],
      );
      plan.targetId = channelId;
    });
  }
}

interface Pending {
  message: ArchiveMessage;
  plan: Plan;
}

/** The text that is stored: the message, then a line for each file it names (the bytes are not copied). */
const bodyOf = (m: ArchiveMessage): string => {
  const lines = m.files.map((f) => `(file: ${f.name})`);
  return [m.text, ...lines].filter((s) => s !== '').join('\n');
};

export async function runImport(input: RunInput): Promise<RunOutcome> {
  const { reader, transaction, mode } = input;
  const tally = new Tally();
  const progress: ImportProgress = { phase: 'people', messagesDone: 0, messagesTotal: input.expectedMessages ?? 0, channelsDone: 0, channelsTotal: 0 };
  const report = async (phase?: ImportProgress['phase']): Promise<void> => {
    if (phase) progress.phase = phase;
    if (mode === 'real' && input.onProgress) await transaction((tx) => input.onProgress!(tx, { ...progress }));
  };
  /** Whether the admin asked to stop; asked before anything is written, so a cancel that came while the run was waiting writes no person and no channel. */
  const stopRequested = async (): Promise<boolean> => mode === 'real' && input.shouldStop !== undefined && transaction((tx) => input.shouldStop!(tx));
  const stopped = (): RunOutcome => ({ report: buildReport(tally, 'final'), cancelled: true });

  // People who sign in during a long run take their placeholder's messages over (a database trigger). Anything the run wrote as such a placeholder after the
  // person signed in is moved at the end; `since` (a little before the run) bounds which claims that is.
  const since = mode === 'real' ? (await transaction((tx) => tx.query<{ t: Date }>("SELECT now() - interval '10 minutes' AS t"))).rows[0]!.t : null;

  if (await stopRequested()) return stopped();
  const people = await reader.people();
  await report('people');
  const resolved = await resolvePeople(input, tally, people);
  if (await stopRequested()) return stopped();
  const channels = await reader.channels();
  progress.channelsTotal = channels.length;
  await report('channels');
  const plans = await planChannels(input, tally, channels, resolved);
  if (mode === 'real') await createChannels(input, plans);
  progress.channelsDone = plans.length;
  const planByKey = new Map(plans.map((p) => [p.channel.key, p]));

  await report('messages');
  const extraPeople = new Map<string, string>();
  const rootIds = new Map<string, string>();
  const actorFor = async (tx: PluginTx, key: string): Promise<string | null> => {
    const r = resolved.get(key);
    if (r) return r.actorId ?? NIL_UUID;
    // an author the archive's user list does not describe: a placeholder with no email
    const have = extraPeople.get(key);
    if (have) return have;
    tally.people.total += 1;
    tally.people.placeholders += 1;
    tally.people.withoutEmail += 1;
    const label = (reader.nameOf?.(key) ?? key).slice(0, 40);
    const actor = mode === 'real' ? await ensurePlaceholder(tx, input.workspaceId, input.source, key, `Unknown (${label})`, null) : NIL_UUID;
    extraPeople.set(key, actor);
    return actor;
  };

  // Placeholders that are still waiting for their person; one query per batch looks for those claimed since the run began.
  let waiting = 0;
  if (mode === 'real') for (const r of resolved.values()) if (r.kind === 'placeholder' && r.actorId !== null) waiting += 1;
  const refreshClaims = async (tx: PluginTx): Promise<void> => {
    if (mode !== 'real' || waiting === 0) return;
    const res = await tx.query<{ source_id: string; person_id: string; actor_id: string; on_team: boolean }>(
      `SELECT ip.source_id, ip.claimed_by AS person_id, ca.id AS actor_id,
              EXISTS (SELECT 1 FROM app.team_members tm WHERE tm.team_id = $4 AND tm.actor_id = ca.id) AS on_team
         FROM app.import_people ip
         JOIN app.actors ca ON ca.kind = 'person' AND ca.ref_id = ip.claimed_by AND ca.workspace_id = ip.workspace_id
        WHERE ip.workspace_id = $1 AND ip.source = $2 AND ip.claimed_at IS NOT NULL AND ip.claimed_at >= $3`,
      [input.workspaceId, input.source, since, input.teamId],
    );
    for (const r of res.rows) {
      if (resolved.get(r.source_id)?.kind !== 'placeholder') continue;
      resolved.set(r.source_id, { kind: 'matched', personId: r.person_id, actorId: r.actor_id, onTeam: r.on_team });
      waiting -= 1;
    }
  };

  let cancelled = false;
  let batch: Pending[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    await transaction(async (tx) => {
      if (input.shouldStop && (await input.shouldStop(tx))) {
        cancelled = true;
        return;
      }
      await refreshClaims(tx);
      await processBatch(tx, current);
      progress.messagesDone = tally.messages.imported + tally.messages.alreadyImported;
      if (mode === 'real' && input.onProgress) await input.onProgress(tx, { ...progress });
    });
  };

  const processBatch = async (tx: PluginTx, items: Pending[]): Promise<void> => {
    const keyOf = (plan: Plan, key: string): string => mapKey(input.teamId, plan.channel.kind, key);
    const keys = items.map((i) => keyOf(i.plan, i.message.key));
    const rootKeys = items.map((i) => (i.message.rootKey === null ? null : keyOf(i.plan, i.message.rootKey))).filter((k): k is string => k !== null && !rootIds.has(k));
    const found = await lookupMessages(tx, input.workspaceId, input.source, [...keys, ...rootKeys]);
    const mapRows: { key: string; target: string }[] = [];
    for (const { message: m, plan } of items) {
      const mapped = keyOf(plan, m.key);
      const rootMapped = m.rootKey === null ? null : keyOf(plan, m.rootKey);
      const earlier = found.get(mapped);
      if (earlier) {
        if (earlier.runId === input.runId) tally.messages.imported += 1;
        else tally.messages.alreadyImported += 1;
        if (m.startsThread) rootIds.set(mapped, earlier.target);
        continue;
      }
      if (m.authorKey === null) {
        tally.skip('system_message');
        continue;
      }
      const author = await actorFor(tx, m.authorKey);
      if (author === null) continue;
      if (plan.channel.kind === 'direct' && mode === 'real' && !plan.memberActorIds.has(author)) {
        tally.skip('dm_not_matched');
        continue;
      }
      const rootTarget = rootMapped === null ? null : (rootIds.get(rootMapped) ?? found.get(rootMapped)?.target ?? null);
      if (m.rootKey !== null && rootTarget === null) tally.skip('orphan_reply');
      if (m.shortened) tally.skip('message_shortened');
      const reactions: { emoji: string; actorIds: string[] }[] = [];
      let reactionRows = 0;
      for (const r of m.reactions) {
        const ids: string[] = [];
        for (const k of r.userKeys) {
          const who = resolved.get(k);
          if (who) ids.push(who.actorId ?? NIL_UUID);
          else tally.skip('reaction_unknown_person');
        }
        if (ids.length > 0) {
          reactions.push({ emoji: r.emoji, actorIds: [...new Set(ids)] });
          reactionRows += new Set(ids).size;
        }
      }
      let id = NIL_UUID;
      if (mode === 'real') {
        await tx.query('SELECT app.import_act_as($1)', [author]);
        const posted: MessagePosted = await input.provider.post(tx, {
          channelId: plan.targetId!,
          body: bodyOf(m),
          threadRootId: rootTarget,
          imported: { at: isoOf(m.at), source: input.source, sourceId: m.key, reactions },
        });
        id = posted.id;
        mapRows.push({ key: mapped, target: id });
      }
      tally.messages.imported += 1;
      tally.messages.mentions += m.mentions;
      tally.messages.reactions += reactionRows;
      if (m.startsThread) tally.messages.threads += 1;
      if (rootTarget !== null) tally.messages.replies += 1;
      if (m.startsThread) {
        rootIds.set(mapped, id);
        if (rootIds.size > 200_000) rootIds.delete(rootIds.keys().next().value as string);
      }
    }
    if (mapRows.length > 0) {
      await tx.query(
        `INSERT INTO app.import_map (workspace_id, source, kind, source_id, target_id, run_id)
         SELECT $1, $2, 'message', k, t, $5 FROM unnest($3::text[], $4::uuid[]) AS x(k, t)
         ON CONFLICT (workspace_id, source, kind, source_id) DO NOTHING`,
        [input.workspaceId, input.source, mapRows.map((r) => r.key), mapRows.map((r) => r.target), input.runId],
      );
    }
  };

  const include = (key: string): boolean => {
    const p = planByKey.get(key);
    return p !== undefined && (mode === 'dry' || p.outcome !== 'skip');
  };
  for await (const m of reader.messages(include)) {
    const plan = planByKey.get(m.channelKey);
    if (!plan) continue;
    tally.messages.total += 1;
    plan.messages += 1;
    for (const f of m.files) {
      tally.files.total += 1;
      if (f.inArchive) tally.files.inArchive += 1;
      else {
        tally.files.notInArchive += 1;
        tally.skip('file_not_in_export');
      }
    }
    if (plan.outcome === 'skip') continue;
    if (m.skip) {
      tally.skip(m.skip);
      continue;
    }
    batch.push({ message: m, plan });
    if (batch.length >= BATCH_SIZE) {
      await flush();
      if (cancelled) break;
    }
  }
  if (!cancelled) await flush();
  if (!cancelled) {
    await report('finishing');
  }
  // whoever signed in while this ran: what was written as their placeholder after that moment becomes theirs (the same move the sign-in trigger makes)
  if (mode === 'real') await transaction((tx) => tx.query('SELECT app.import_move_claimed($1, $2, $3)', [input.workspaceId, input.source, since]));

  for (const [reason, n] of reader.notes) tally.skip(reason, n);
  for (const plan of plans) {
    tally.channelLines.push({
      name: plan.channel.kind === 'direct' ? 'direct conversation' : plan.channel.name.slice(0, 120),
      kind: plan.channel.kind,
      messages: plan.messages,
      outcome: plan.outcome,
      reason: plan.reason,
      becomes: plan.channel.kind === 'direct' || plan.outcome === 'skip' ? null : (plan.becomes ?? importChannelName(channelBaseName(plan.channel))),
    });
  }
  return { report: buildReport(tally, mode === 'dry' ? 'dry' : 'final'), cancelled };
}
