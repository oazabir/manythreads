import { describe, expect, it } from 'vitest';
import { PersonalRoutine, PersonalRoutineStopReason, PERSONAL_ROUTINE_STOP_WORDS } from '../../src/entities/scheduled-job.ts';
import { CreatePersonalRoutineRequest, DraftPersonalRoutineRequest, UpdatePersonalRoutineRequest } from '../../src/api/scheduled-jobs/me.ts';
import { ScheduledJobsScheduledJobRanEvent, ScheduledJobsScheduledJobStoppedEvent, eventRegistry, latestVersion, parseEvent } from '../../src/events/index.ts';

const WS = '00000000-0000-7000-8000-00000000a001';
const PERSON = '00000000-0000-7000-8000-0000000c0001';
const BOT = '00000000-0000-7000-8000-0000000f0002';
const JOB = '00000000-0000-7000-8000-0000000f0003';
const RUN = '00000000-0000-7000-8000-0000000f0004';

describe('personal routine events', () => {
  it('registers the stopped event at version 1 and parses it', () => {
    expect(Object.keys(eventRegistry)).toContain('scheduled_jobs.scheduled_job.stopped');
    expect(latestVersion('scheduled_jobs.scheduled_job.stopped')).toBe(1);
    const e = parseEvent({ type: 'scheduled_jobs.scheduled_job.stopped', schemaVersion: 1, workspaceId: WS, scheduledJobId: JOB, ownerPersonId: PERSON, botId: BOT, reason: 'consent_withdrawn' });
    expect(e.type).toBe('scheduled_jobs.scheduled_job.stopped');
  });

  it('refuses a reason that is not a code, and the routine words are never in the event', () => {
    const bad = { type: 'scheduled_jobs.scheduled_job.stopped', schemaVersion: 1, workspaceId: WS, scheduledJobId: JOB, ownerPersonId: PERSON, botId: BOT, reason: 'because I said so' };
    expect(ScheduledJobsScheduledJobStoppedEvent.safeParse(bad).success).toBe(false);
    expect(Object.keys(ScheduledJobsScheduledJobStoppedEvent.shape)).not.toContain('words');
  });

  it('has a plain sentence for every stop reason', () => {
    for (const r of PersonalRoutineStopReason.options) expect(PERSONAL_ROUTINE_STOP_WORDS[r].length).toBeGreaterThan(10);
  });

  it('keeps the ran event readable when it has no team (a personal routine) and when it is an old one', () => {
    const base = {
      type: 'scheduled_jobs.scheduled_job.ran', schemaVersion: 1, workspaceId: WS, scheduledJobId: JOB, scheduledJobRunId: RUN, botId: BOT, kind: 'routine',
      status: 'queued', outputPath: 'Routines/x/output.md', taskId: null, reason: '',
    };
    const personal = ScheduledJobsScheduledJobRanEvent.parse({ ...base, teamId: null, ownerPersonId: PERSON });
    expect(personal.teamId).toBeNull();
    expect(personal.ownerPersonId).toBe(PERSON);
    const old = ScheduledJobsScheduledJobRanEvent.parse({ ...base, teamId: '00000000-0000-7000-8000-0000000b0001' });
    expect(old.ownerPersonId).toBeUndefined();
  });
});

describe('personal routine requests', () => {
  const create = {
    confirmed: true, name: 'Morning brief', schedule: '0 3 * * 1-5', scheduleWords: 'Weekdays at 7:00 AM', timeZone: 'Asia/Dubai', prompt: 'Summarise my mail.',
  };

  it('needs the person’s confirmation and nothing unknown', () => {
    expect(CreatePersonalRoutineRequest.parse(create).botSlug).toBe('brain');
    expect(CreatePersonalRoutineRequest.safeParse({ ...create, confirmed: false }).success).toBe(false);
    const without: Record<string, unknown> = { ...create };
    delete without['confirmed'];
    expect(CreatePersonalRoutineRequest.safeParse(without).success).toBe(false);
    expect(CreatePersonalRoutineRequest.safeParse({ ...create, teamId: '00000000-0000-7000-8000-0000000b0001' }).success).toBe(false);
    expect(CreatePersonalRoutineRequest.safeParse({ ...create, ownerPersonId: PERSON }).success).toBe(false);
  });

  it('keeps the output inside the person’s files and out of Memory', () => {
    for (const outputPath of ['Routines/brief/output.md', 'Notes/daily.md']) expect(CreatePersonalRoutineRequest.safeParse({ ...create, outputPath }).success).toBe(true);
    for (const outputPath of ['../etc/passwd', '/Notes/x.md', 'Notes//x.md', 'Memory/index.md', 'file.md', 'Notes/../Memory/x.md']) {
      expect(CreatePersonalRoutineRequest.safeParse({ ...create, outputPath }).success, outputPath).toBe(false);
    }
  });

  it('has no field that could name another owner, team or asker on update or draft', () => {
    expect(UpdatePersonalRoutineRequest.safeParse({ enabled: true }).success).toBe(true);
    for (const key of ['ownerPersonId', 'teamId', 'askerPersonId', 'botSlug', 'space']) expect(UpdatePersonalRoutineRequest.safeParse({ [key]: PERSON }).success, key).toBe(false);
    expect(DraftPersonalRoutineRequest.safeParse({ sentence: 'every day at 7', timeZone: 'Asia/Dubai', teamId: PERSON }).success).toBe(false);
    expect(Object.keys(PersonalRoutine.shape)).toEqual(expect.arrayContaining(['ownerPersonId', 'askerPersonId']));
  });
});
