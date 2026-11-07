import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { createPersonalFilesProvider } from '../src/personal-store.ts';

// P21-F: `removeFolder` of the `personal.files` provider refuses a path that could reach outside one named folder before it asks the database anything.
// (What it removes, and what it leaves, is proved against a real database by the scheduled-jobs routine delete test.)

const PERSON = '00000000-0000-7000-8000-0000000e0001';

function rig() {
  const queries: string[] = [];
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as PluginTx;
  const provider = createPersonalFilesProvider({} as PluginContext);
  return { provider, tx, queries };
}

describe('removeFolder', () => {
  it.each([
    ['an empty path', ''],
    ['the root slash', '/'],
    ['a trailing slash', 'Routines/a/'],
    ['a leading slash', '/Routines/a'],
    ['a double slash', 'Routines//a'],
    ['a dot part', 'Routines/./a'],
    ['a dot-dot part', 'Routines/../Notes'],
    ['a dot-dot alone', '..'],
    ['a folder every space starts with', 'Routines'],
    ['another starting folder', 'Memory'],
    ['a path of more than 500 characters', `Routines/${'a'.repeat(500)}`],
  ])('refuses %s and asks the database nothing', async (_label, path) => {
    const r = rig();
    await expect(r.provider.removeFolder(r.tx, PERSON, path)).rejects.toMatchObject({ status: 400 });
    expect(r.queries).toEqual([]);
  });
});
