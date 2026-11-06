import { describe, expect, it } from 'vitest';
import { Board, BoardColumn, CreateBoardRequest, MoveTaskRequest, ReorderBoardColumnsRequest, readStoredColumn } from '../src/index.ts';

const WS = '019aaaaa-0000-7000-8000-000000000001';
const col = (id: string, state = 'verify') => ({ id, name: id.toUpperCase(), state, title: id.toUpperCase() });
const board = (columns: unknown[]) => ({ id: WS, workspaceId: WS, teamId: WS, name: 'B', columns, filter: {}, channelId: null, createdAt: '2026-11-06T00:00:00.000Z' });

describe('board columns', () => {
  it('reads an older column (state and title only) with its state as id and title as name', () => {
    expect(readStoredColumn({ state: 'verify', title: 'Verify' })).toEqual({ id: 'verify', name: 'Verify', state: 'verify', title: 'Verify' });
  });
  it('reads a new column as it is, and refuses a stored thing that is not a column', () => {
    expect(readStoredColumn(col('c_ab12'))).toEqual(col('c_ab12'));
    expect(readStoredColumn({ state: 'nope', title: 'x' })).toBeNull();
    expect(readStoredColumn(null)).toBeNull();
  });
  it('lets two columns count as the same state, but not share an id', () => {
    expect(Board.safeParse(board([col('review'), col('qa')])).success).toBe(true);
    expect(Board.safeParse(board([col('qa'), col('qa')])).success).toBe(false);
  });
  it('holds at most 12 columns', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => col(`c${i}`));
    expect(Board.safeParse(board(many(12))).success).toBe(true);
    expect(Board.safeParse(board(many(13))).success).toBe(false);
    expect(Board.safeParse(board([])).success).toBe(false);
  });
  it('refuses an id with capitals or spaces', () => {
    expect(BoardColumn.safeParse(col('Bad Id')).success).toBe(false);
  });
  it('takes new columns as a name and a state, repeated states allowed', () => {
    expect(CreateBoardRequest.safeParse({ name: 'B', columns: [{ name: 'Code review', state: 'verify' }, { name: 'QA', state: 'verify' }] }).success).toBe(true);
    expect(CreateBoardRequest.safeParse({ name: 'B', columns: [{ name: 'x', state: 'verify', id: 'c_1' }] }).success).toBe(false);
  });
  it('needs a state or a column to move a card to', () => {
    const taskId = WS;
    expect(MoveTaskRequest.safeParse({ taskId }).success).toBe(false);
    expect(MoveTaskRequest.safeParse({ taskId, to: 'verify' }).success).toBe(true);
    expect(MoveTaskRequest.safeParse({ taskId, columnId: 'c_ab12' }).success).toBe(true);
  });
  it('reorders by a list of ids', () => {
    expect(ReorderBoardColumnsRequest.safeParse({ columnIds: [] }).success).toBe(false);
    expect(ReorderBoardColumnsRequest.safeParse({ columnIds: ['open', 'done'] }).success).toBe(true);
  });
});
