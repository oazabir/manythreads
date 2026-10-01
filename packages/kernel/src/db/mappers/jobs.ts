import { Job } from '@manythreads/shared';

export interface JobRow {
  id: string;
  queue: string;
  payload: unknown;
  run_at: Date;
  state: string;
  attempts: number;
  dedupe_key: string | null;
  created_at: Date;
}

export const toJob = (row: JobRow): Job =>
  Job.parse({
    id: row.id,
    queue: row.queue,
    payload: row.payload,
    runAt: row.run_at.toISOString(),
    state: row.state,
    attempts: row.attempts,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at.toISOString(),
  });
