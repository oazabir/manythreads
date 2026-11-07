import { HttpError, type PersonalFilesProvider, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  CreatePersonalRoutineRequest,
  CreatePersonalRoutineResponse,
  DeletePersonalRoutineResponse,
  DraftPersonalRoutineRequest,
  DraftPersonalRoutineResponse,
  ListPersonalRoutineRunsResponse,
  ListPersonalRoutinesResponse,
  PERSONAL_ROUTINE_LIMITS,
  RoutineWorkspaceSettings,
  RunPersonalRoutineResponse,
  UpdatePersonalRoutineRequest,
  UpdatePersonalRoutineResponse,
  UpdateRoutineSettingsRequest,
  UpdateRoutineSettingsResponse,
  UpdateRoutineWorkspaceSettingsRequest,
  cronToWords,
  createPersonalRoutineRoute,
  deletePersonalRoutineRoute,
  draftPersonalRoutineRoute,
  getRoutineWorkspaceSettingsRoute,
  isTimeZone,
  listPersonalRoutineRunsRoute,
  personalRecipeById,
  listPersonalRoutinesRoute,
  minGapMinutes,
  parseCron,
  runPersonalRoutineRoute,
  updatePersonalRoutineRoute,
  updateRoutineSettingsRoute,
  updateRoutineWorkspaceSettingsRoute,
  type PersonalRoutineStopReason,
  type RoutineSource,
} from '@manythreads/shared';
import { conflict, forbidden, invalid, json, notFound, route } from '@manythreads/sdk';
import { draftRoutine } from './draft.ts';
import { buildContractText, contractPathOf, defaultOutputPathOf, parseContractText, slugFor, type PersonalContract } from './personal-contract.ts';
import {
  getSettings,
  missingConnections,
  monthlyCapUsd,
  requireMemberOrNull,
  resolveBotFor,
  runBlocker,
  spentAsPerson,
  sourceLabel,
  type Member,
} from './personal-limits.ts';
import { PERSONAL_JOB_SELECT, toPersonalRoutine, toPersonalRun, type PersonalJobRow, type PersonalRunRow } from './personal-rows.ts';
import { firingInFlight, startPersonalRun, type PersonalDueRow } from './personal-tick.ts';
import { nextRunFor } from './scheduler.ts';

// A person's own routines: /api/me/scheduled-jobs (PLAN P20-10 to P20-14). Every route starts with the member check (a guest has no Personal space and so no routines) and
// reads or writes through row level security, which is the real rule: another person's routine is simply not there.

const needMember = async (tx: PluginTx): Promise<Member> => {
  const member = await requireMemberOrNull(tx);
  if (!member) throw forbidden('Routines are for members of the workspace');
  return member;
};

const filesOf = (ctx: PluginContext): PersonalFilesProvider => {
  const files = ctx.providers.get<PersonalFilesProvider>('personal.files');
  if (!files) throw new HttpError(503, 'internal', 'Personal files are not available right now');
  return files;
};

/** The plain sentence for a thing that stops a routine from being made or turned on. */
function blockerSentence(reason: PersonalRoutineStopReason, botName: string, missing: readonly RoutineSource[]): string {
  switch (reason) {
    case 'bot_off':
      return `${botName} is turned off right now, so a routine cannot use it.`;
    case 'bot_gone':
      return 'The bot that runs this routine is no longer there. Make a new routine with another bot.';
    case 'not_a_member':
      return `You are not on the team of ${botName}, so it cannot work for you.`;
    case 'consent_withdrawn':
      return `${botName} cannot read your Personal space. Turn that on in Account, under Bots, and try again.`;
    case 'connection_gone':
      return `Connect your ${missing.map((s) => sourceLabel(s).replace(/^My /, '')).join(' and ')} first (Account, then Connections), or take it out of this routine.`;
    case 'owner_deactivated':
      return 'Your account is not active.';
    case 'spend_cap':
      return 'Your routines have used up this month’s allowance.';
  }
}

async function checkSchedule(schedule: string, timeZone: string, now: Date): Promise<void> {
  if (!isTimeZone(timeZone)) throw invalid('That time zone is not one I know');
  try {
    parseCron(schedule);
  } catch (err) {
    throw invalid(err instanceof Error ? err.message : 'invalid schedule');
  }
  if (nextRunFor(schedule, now) === null) throw invalid('This schedule never fires');
  const gap = minGapMinutes(schedule, now);
  if (gap !== null && gap < PERSONAL_ROUTINE_LIMITS.minIntervalMinutes) {
    throw invalid(`A routine can run at most once every ${PERSONAL_ROUTINE_LIMITS.minIntervalMinutes} minutes`);
  }
}

async function loadOwn(tx: PluginTx, member: Member, id: string, lock = false): Promise<PersonalJobRow> {
  const row = (
    await tx.query<PersonalJobRow>(`${PERSONAL_JOB_SELECT} WHERE j.id = $1::uuid AND j.owner_person_id = $2::uuid${lock ? ' FOR UPDATE OF j' : ''}`, [id, member.personId])
  ).rows[0];
  if (!row) throw notFound('No such routine');
  return row;
}

/** The contract as the file has it now, or one rebuilt from the routine's row when the file is missing or no longer reads. */
async function currentContract(files: PersonalFilesProvider, tx: PluginTx, row: PersonalJobRow): Promise<PersonalContract> {
  try {
    const file = await files.read(tx, row.owner_person_id, row.contract_path);
    if (file) return parseContractText(file.text, row.contract_path);
  } catch {
    // rebuilt below
  }
  return {
    name: row.name,
    words: row.words,
    schedule: row.schedule,
    timeZone: row.time_zone,
    sources: row.sources as RoutineSource[],
    prompt: row.words.trim() !== '' ? row.words : row.name,
    output: { path: row.output_path, mode: row.output_mode as 'create' | 'replace' | 'append' },
  };
}

export function registerPersonalRoutes(ctx: PluginContext): void {
  const now = (): Date => ctx.runtime.now();

  ctx.http.route({
    ...listPersonalRoutinesRoute,
    schema: { response: ListPersonalRoutinesResponse },
    handler: route(async (_req, tx) => {
      const member = await needMember(tx);
      const rows = (await tx.query<PersonalJobRow>(`${PERSONAL_JOB_SELECT} WHERE j.owner_person_id = $1::uuid ORDER BY j.created_at, j.id`, [member.personId])).rows;
      const at = now();
      return json(
        ListPersonalRoutinesResponse.parse({
          items: rows.map((r) => toPersonalRoutine(r, at)),
          limits: {
            maxRoutines: PERSONAL_ROUTINE_LIMITS.maxPerPerson,
            used: rows.length,
            minIntervalMinutes: PERSONAL_ROUTINE_LIMITS.minIntervalMinutes,
            monthlyCapUsd: await monthlyCapUsd(tx, member.workspaceId),
            spentUsd: await spentAsPerson(tx, member.personId, at),
            runToolCalls: PERSONAL_ROUTINE_LIMITS.runToolCalls,
          },
          settings: await getSettings(tx, member.personId),
        }),
      );
    }),
  });

  ctx.http.route({
    ...createPersonalRoutineRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: CreatePersonalRoutineRequest, response: CreatePersonalRoutineResponse },
    handler: route(async (req, tx) => {
      const member = await needMember(tx);
      const body = CreatePersonalRoutineRequest.parse(req.body);
      const at = now();
      if (body.recipeId !== undefined && !personalRecipeById(body.recipeId)) throw invalid('That recipe is not one I know');
      await checkSchedule(body.schedule, body.timeZone, at);
      const bot = await resolveBotFor(tx, member.personId, body.botSlug);
      if (!bot) throw notFound('No such bot');
      const blocker = await runBlocker(tx, { personId: member.personId, botId: bot.id, sources: body.sources });
      if (blocker !== null) throw conflict(blockerSentence(blocker, bot.name, await missingConnections(tx, member.personId, body.sources)));
      const taken = new Set((await tx.query<{ slug: string }>('SELECT slug FROM app.scheduled_jobs WHERE owner_person_id = $1::uuid', [member.personId])).rows.map((r) => r.slug));
      if (taken.size >= PERSONAL_ROUTINE_LIMITS.maxPerPerson) throw conflict(`You already have ${PERSONAL_ROUTINE_LIMITS.maxPerPerson} routines; remove one to make room for another.`);
      const slug = slugFor(body.name, taken);
      const outputPath = body.outputPath ?? defaultOutputPathOf(slug);
      // the conversation channel of this person with this bot is what makes the bot's run a private one (it reads what its asker may read)
      await tx.query('SELECT * FROM app.conversations_open($1::uuid)', [bot.id]);
      const contract: PersonalContract = {
        name: body.name,
        words: body.words,
        schedule: body.schedule,
        timeZone: body.timeZone,
        sources: body.sources,
        prompt: body.prompt,
        output: { path: outputPath, mode: body.outputMode },
      };
      await filesOf(ctx).write(tx, member.personId, contractPathOf(slug), buildContractText(contract), { mode: 'create' });
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.scheduled_jobs (workspace_id, owner_person_id, bot_id, name, kind, schedule, contract_path, output_path, enabled, next_run_at, created_by,
                                            slug, words, schedule_words, time_zone, sources, output_mode, recipe_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'routine', $5, $6, $7, true, $8, $9::uuid, $10, $11, $12, $13, $14::text[], $15, $16)
           RETURNING id`,
          [
            member.workspaceId,
            member.personId,
            bot.id,
            body.name,
            body.schedule,
            contractPathOf(slug),
            outputPath,
            nextRunFor(body.schedule, at),
            member.actorId,
            slug,
            body.words,
            body.scheduleWords,
            body.timeZone,
            body.sources,
            body.outputMode,
            body.recipeId ?? null,
          ],
        )
      ).rows[0]!.id;
      return json(CreatePersonalRoutineResponse.parse({ routine: toPersonalRoutine(await loadOwn(tx, member, id), at) }), 201);
    }),
  });

  ctx.http.route({
    ...updatePersonalRoutineRoute,
    schema: { body: UpdatePersonalRoutineRequest, response: UpdatePersonalRoutineResponse },
    handler: route(async (req, tx) => {
      const member = await needMember(tx);
      const { scheduledJobId } = req.params as { scheduledJobId: string };
      const body = UpdatePersonalRoutineRequest.parse(req.body ?? {});
      const at = now();
      const row = await loadOwn(tx, member, scheduledJobId, true);

      const schedule = body.schedule ?? row.schedule;
      const timeZone = body.timeZone ?? row.time_zone;
      const sources = (body.sources ?? row.sources) as RoutineSource[];
      const enabled = body.enabled ?? row.enabled;
      const scheduleChanged = body.schedule !== undefined || body.timeZone !== undefined;
      if (scheduleChanged || enabled) await checkSchedule(schedule, timeZone, at);

      // turning a routine on (or leaving it on after a change) must still be allowed: its bot, the person's yes, the connections and the month's allowance
      const turningOn = enabled && (!row.enabled || row.stopped_reason !== null);
      if (turningOn || (enabled && body.sources !== undefined)) {
        const blocker = await runBlocker(tx, { personId: member.personId, botId: row.bot_id, sources });
        if (blocker !== null) throw conflict(blockerSentence(blocker, row.bot_name ?? 'The bot', await missingConnections(tx, member.personId, sources)));
      }
      if (turningOn && (await spentAsPerson(tx, member.personId, at)) >= (await monthlyCapUsd(tx, member.workspaceId))) {
        throw conflict(blockerSentence('spend_cap', row.bot_name ?? 'The bot', []));
      }

      const outputPath = body.outputPath ?? row.output_path;
      const outputMode = body.outputMode ?? row.output_mode;
      const words = body.words ?? row.words;
      const name = body.name ?? row.name;
      const scheduleWords = body.scheduleWords ?? (scheduleChanged ? cronToWords(schedule, timeZone, at) : row.schedule_words);

      // what the file says follows what the routine says: a new version of the file for any change the file shows
      const fileChanged =
        body.name !== undefined || body.words !== undefined || body.prompt !== undefined || body.schedule !== undefined || body.timeZone !== undefined ||
        body.sources !== undefined || body.outputPath !== undefined || body.outputMode !== undefined;
      if (fileChanged) {
        const current = await currentContract(filesOf(ctx), tx, row);
        const next: PersonalContract = {
          ...current,
          name,
          words,
          schedule,
          timeZone,
          sources,
          prompt: body.prompt ?? current.prompt,
          output: { path: outputPath, mode: outputMode as 'create' | 'replace' | 'append' },
        };
        await filesOf(ctx).write(tx, member.personId, row.contract_path, buildContractText(next), { mode: 'replace' });
      }

      const next = enabled ? nextRunFor(schedule, at) : null;
      await tx.query(
        `UPDATE app.scheduled_jobs
            SET name = $2, words = $3, schedule = $4, schedule_words = $5, time_zone = $6, sources = $7::text[], output_path = $8, output_mode = $9,
                enabled = $10, next_run_at = $11, stopped_reason = CASE WHEN $10 THEN NULL ELSE stopped_reason END,
                stopped_at = CASE WHEN $10 THEN NULL ELSE stopped_at END, stop_told_at = CASE WHEN $10 THEN NULL ELSE stop_told_at END, updated_at = now()
          WHERE id = $1::uuid AND owner_person_id = $12::uuid`,
        [row.id, name, words, schedule, scheduleWords, timeZone, sources, outputPath, outputMode, enabled, next, member.personId],
      );
      return json(UpdatePersonalRoutineResponse.parse({ routine: toPersonalRoutine(await loadOwn(tx, member, row.id), at) }));
    }),
  });

  // Deleting a routine removes the routine and its firings. Its folder in Files (the routine file, earlier outputs) stays: those are the person's own files.
  ctx.http.route({
    ...deletePersonalRoutineRoute,
    schema: { response: DeletePersonalRoutineResponse },
    handler: route(async (req, tx) => {
      const member = await needMember(tx);
      const { scheduledJobId } = req.params as { scheduledJobId: string };
      const row = await loadOwn(tx, member, scheduledJobId);
      await tx.query('DELETE FROM app.scheduled_jobs WHERE id = $1::uuid AND owner_person_id = $2::uuid', [row.id, member.personId]);
      return json(DeletePersonalRoutineResponse.parse({ deleted: true }));
    }),
  });

  ctx.http.route({
    ...runPersonalRoutineRoute,
    rateLimit: { limit: 10, windowMs: 60_000 },
    schema: { response: RunPersonalRoutineResponse },
    handler: route(async (req, tx) => {
      const member = await needMember(tx);
      const { scheduledJobId } = req.params as { scheduledJobId: string };
      const row = await loadOwn(tx, member, scheduledJobId, true);
      const at = now();
      const blocker = await runBlocker(tx, { personId: member.personId, botId: row.bot_id, sources: row.sources as RoutineSource[] });
      if (blocker !== null) throw conflict(blockerSentence(blocker, row.bot_name ?? 'The bot', await missingConnections(tx, member.personId, row.sources as RoutineSource[])));
      if ((await spentAsPerson(tx, member.personId, at)) >= (await monthlyCapUsd(tx, member.workspaceId))) throw conflict(blockerSentence('spend_cap', row.bot_name ?? 'The bot', []));
      if (await firingInFlight(tx, row.id)) throw conflict('This routine is already running; wait for it to finish.');
      const started = await startPersonalRun(ctx, tx, row as unknown as PersonalDueRow, at);
      return json(RunPersonalRoutineResponse.parse({ run: toPersonalRun(started as PersonalRunRow) }), 202);
    }),
  });

  ctx.http.route({
    ...listPersonalRoutineRunsRoute,
    schema: { response: ListPersonalRoutineRunsResponse },
    handler: route(async (req, tx) => {
      const member = await needMember(tx);
      const { scheduledJobId } = req.params as { scheduledJobId: string };
      const row = await loadOwn(tx, member, scheduledJobId);
      const runs = (
        await tx.query<PersonalRunRow>(
          'SELECT id, scheduled_job_id, run_id, status, output_path, reason, started_at, ended_at, sources_used FROM app.scheduled_job_runs WHERE scheduled_job_id = $1::uuid ORDER BY id DESC LIMIT 50',
          [row.id],
        )
      ).rows;
      return json(ListPersonalRoutineRunsResponse.parse({ items: runs.map(toPersonalRun) }));
    }),
  });

  // Setting up in words: a proposal, never a routine. Nothing is written.
  ctx.http.route({
    ...draftPersonalRoutineRoute,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { body: DraftPersonalRoutineRequest, response: DraftPersonalRoutineResponse },
    handler: route(async (req, tx) => {
      const member = await needMember(tx);
      const body = DraftPersonalRoutineRequest.parse(req.body);
      if (!isTimeZone(body.timeZone)) throw invalid('That time zone is not one I know');
      const bot = await resolveBotFor(tx, member.personId, 'brain');
      const taken = new Set((await tx.query<{ slug: string }>('SELECT slug FROM app.scheduled_jobs WHERE owner_person_id = $1::uuid', [member.personId])).rows.map((r) => r.slug));
      const outcome = await draftRoutine(ctx, {
        sentence: body.sentence,
        timeZone: body.timeZone,
        botSlug: bot?.slug ?? 'brain',
        botId: bot?.id ?? null,
        teamId: bot?.team_id ?? null,
        workspaceId: member.workspaceId,
        takenSlugs: taken,
        now: now(),
      });
      const missing = await missingConnections(tx, member.personId, outcome.draft.sources);
      const notes = [...outcome.notes];
      if (missing.length > 0) notes.push(`You have not connected ${missing.map((s) => sourceLabel(s).replace(/^My /, '')).join(' or ')} yet; connect it (Account, then Connections) before you save, or take it out.`);
      return json(DraftPersonalRoutineResponse.parse({ draft: outcome.draft, notes: notes.slice(0, 8), by: outcome.by }));
    }),
  });

  ctx.http.route({
    ...updateRoutineSettingsRoute,
    schema: { body: UpdateRoutineSettingsRequest, response: UpdateRoutineSettingsResponse },
    handler: route(async (req, tx) => {
      const member = await needMember(tx);
      const body = UpdateRoutineSettingsRequest.parse(req.body ?? {});
      if (body.timeZone && !isTimeZone(body.timeZone)) throw invalid('That time zone is not one I know');
      const current = await getSettings(tx, member.personId);
      const timeZone = body.timeZone === undefined ? current.timeZone : body.timeZone;
      const quiet = body.quietHours === undefined ? current.quietHours : body.quietHours;
      await tx.query(
        `INSERT INTO app.routine_person_settings (person_id, workspace_id, time_zone, quiet_from, quiet_to)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5)
         ON CONFLICT (person_id) DO UPDATE SET time_zone = EXCLUDED.time_zone, quiet_from = EXCLUDED.quiet_from, quiet_to = EXCLUDED.quiet_to, updated_at = now()`,
        [member.personId, member.workspaceId, timeZone, quiet?.from ?? null, quiet?.to ?? null],
      );
      return json(UpdateRoutineSettingsResponse.parse({ settings: await getSettings(tx, member.personId) }));
    }),
  });

  // The monthly allowance per person: everybody in the workspace may read it, only an owner or admin changes it.
  ctx.http.route({
    ...getRoutineWorkspaceSettingsRoute,
    schema: { response: RoutineWorkspaceSettings },
    handler: route(async (_req, tx) => {
      const member = await needMember(tx);
      return json(RoutineWorkspaceSettings.parse({ monthlyCapUsd: await monthlyCapUsd(tx, member.workspaceId) }));
    }),
  });
  ctx.http.route({
    ...updateRoutineWorkspaceSettingsRoute,
    schema: { body: UpdateRoutineWorkspaceSettingsRequest, response: RoutineWorkspaceSettings },
    handler: route(async (req, tx) => {
      const member = await needMember(tx);
      const body = UpdateRoutineWorkspaceSettingsRequest.parse(req.body);
      const role = (await tx.query<{ role: string | null }>('SELECT app.lookup_workspace_role() AS role')).rows[0]?.role;
      if (role !== 'owner' && role !== 'admin') throw forbidden('Only a workspace owner or admin can change the allowance');
      await tx.query(
        `INSERT INTO app.routine_workspace_settings (workspace_id, monthly_cap_usd, updated_by) VALUES ($1::uuid, $2, $3::uuid)
         ON CONFLICT (workspace_id) DO UPDATE SET monthly_cap_usd = EXCLUDED.monthly_cap_usd, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [member.workspaceId, body.monthlyCapUsd, member.actorId],
      );
      return json(RoutineWorkspaceSettings.parse({ monthlyCapUsd: await monthlyCapUsd(tx, member.workspaceId) }));
    }),
  });
}

