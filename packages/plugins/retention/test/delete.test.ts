import type { PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { deleteRuns, isIntegrityError, sweepStep, type SweepState } from '../src/sweep.ts';

// The delete's error handling and counting without a database: which refusals a run-by-run retry may swallow, and what the counts are made of.

const IDS = ['0190a000-0000-7000-8000-000000000001', '0190a000-0000-7000-8000-000000000002', '0190a000-0000-7000-8000-000000000003'];
const pgError = (code: string): Error => Object.assign(new Error(`pg ${code}`), { code });

const state = (over: Partial<SweepState> = {}): SweepState => ({
  workspaceId: '0190a000-0000-7000-8000-0000000000a1',
  sweepId: '0190a000-0000-7000-8000-0000000000b1',
  dryRun: false,
  startedAt: new Date(Date.now() - 1000).toISOString(),
  runLogCutoff: new Date(Date.now() - 100 * 86_400_000).toISOString(),
  memoryLogCutoff: new Date(Date.now() - 400 * 86_400_000).toISOString(),
  phase: 'runs',
  cursor: null,
  step: 0,
  counts: { runs: 0, runsSkipped: 0, runSourceLines: 0, runTokens: 0, runMemos: 0, memoryLogLines: 0, memosRemoved: 0 },
  ...over,
});

interface Fake {
  tx: PluginTx;
  statements: string[];
}

/** A transaction that answers by the statement's text; `onDelete` decides what each DELETE does. */
function fake(onDelete: (ids: string[]) => { id: string }[] | Error, extra: Record<string, (values: readonly unknown[]) => unknown[]> = {}): Fake {
  const statements: string[] = [];
  const tx = {
    actor: { kind: 'system', id: 'x', workspaceId: 'w' },
    query: (text: string, values: readonly unknown[] = []) => {
      statements.push(text.trim().split('\n')[0]!.slice(0, 60));
      if (/^\s*DELETE FROM app\.bot_runs/.test(text)) {
        const out = onDelete(values[3] as string[]);
        return out instanceof Error ? Promise.reject(out) : Promise.resolve({ rows: out });
      }
      for (const [needle, answer] of Object.entries(extra)) if (text.includes(needle)) return Promise.resolve({ rows: answer(values) });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as PluginTx;
  return { tx, statements };
}

describe('isIntegrityError', () => {
  it.each([
    ['23514', true],
    ['23503', true],
    ['23505', true],
    ['40P01', false],
    ['57014', false],
    ['08006', false],
    ['25P02', false],
  ])('%s -> %s', (code, expected) => {
    expect(isIntegrityError(pgError(code))).toBe(expected);
  });
  it('is false for anything that is not a driver error', () => {
    expect(isIntegrityError(new Error('x'))).toBe(false);
    expect(isIntegrityError(null)).toBe(false);
    expect(isIntegrityError('23514')).toBe(false);
  });
});

describe('deleteRuns', () => {
  it('goes through when the batch goes', async () => {
    const f = fake((ids) => ids.map((id) => ({ id })));
    expect(await deleteRuns(f.tx, state(), new Date().toISOString(), IDS)).toEqual({ deleted: IDS, skipped: [] });
  });

  it('retries run by run after an integrity error and leaves the one the database refuses', async () => {
    const f = fake((ids) => (ids.length > 1 || ids[0] === IDS[1] ? pgError('23514') : ids.map((id) => ({ id }))));
    expect(await deleteRuns(f.tx, state(), new Date().toISOString(), IDS)).toEqual({ deleted: [IDS[0], IDS[2]], skipped: [IDS[1]] });
    expect(f.statements.filter((s) => s.startsWith('ROLLBACK TO SAVEPOINT')).length).toBe(2);
  });

  it.each([['57014', 'a statement timeout'], ['40P01', 'a deadlock'], ['57P01', 'a terminated connection'], ['55P03', 'a lock that could not be had']])(
    'does not swallow %s (%s): it is thrown for the job’s retry, in the batch and in the retry',
    async (code) => {
      const inBatch = fake(() => pgError(code));
      await expect(deleteRuns(inBatch.tx, state(), new Date().toISOString(), IDS)).rejects.toMatchObject({ code });

      // an integrity error first (so the retry starts), then a timeout on one run: still thrown, not "skipped"
      let calls = 0;
      const inRetry = fake((ids) => {
        calls += 1;
        if (calls === 1) return pgError('23514');
        return ids[0] === IDS[1] ? pgError(code) : ids.map((id) => ({ id }));
      });
      await expect(deleteRuns(inRetry.tx, state(), new Date().toISOString(), IDS)).rejects.toMatchObject({ code });
    },
  );
});

describe('the counts of a step', () => {
  it('come from the runs the DELETE returned, not from the ids the select proposed', async () => {
    const f = fake(
      (ids) => ids.filter((id) => id !== IDS[1]).map((id) => ({ id })), // the re-asserted predicate declines the second run
      {
        'FROM app.bot_runs r': () => IDS.map((id, i) => ({ id, ended_at: `2026-01-0${i + 1} 10:00:00+00` })),
        'FROM app.run_source_log': () => [
          { run_id: IDS[0], n: 2 },
          { run_id: IDS[1], n: 50 },
          { run_id: IDS[2], n: 3 },
        ],
        "to_regclass('app.mcp_run_tokens')": () => [{ ok: true }],
        'FROM app.mcp_run_tokens': () => [
          { run_id: IDS[1], n: 7 },
          { run_id: IDS[2], n: 1 },
        ],
        'memory_memoize_runs': () => [{ n: 0 }],
      },
    );
    const result = await sweepStep(f.tx, state());
    expect(result.done).toBe(false);
    if (!result.done) expect(result.state.counts).toMatchObject({ runs: 2, runsSkipped: 0, runSourceLines: 5, runTokens: 1 });
  });
});
