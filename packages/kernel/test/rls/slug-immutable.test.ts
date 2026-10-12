import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type World } from './world.ts';

// Migration 0014: workspace and team slugs never change, for every writer (the system role included); saving the same slug is fine.

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error & { code?: string }) => `${e.code ?? ''} ${e.message}`);

describe('slug immutability', () => {
  it('a team’s slug cannot be changed, not even by the system role', async () => {
    expect(await outcome(w.system((tx) => tx.query(`UPDATE teams SET slug = 'renamed' WHERE id = $1`, [TEAM_IDS.Marketing])))).toMatch(/^23514 the slug of a teams cannot be changed/);
    const slug = await w.system(async (tx) => (await tx.query<{ slug: string }>(`SELECT slug FROM teams WHERE id = $1`, [TEAM_IDS.Marketing])).rows[0]!.slug);
    expect(slug).toBe('marketing');
  });

  it('a workspace’s slug cannot be changed', async () => {
    expect(await outcome(w.system((tx) => tx.query(`UPDATE workspaces SET slug = 'renamed'`)))).toMatch(/^23514 the slug of a workspaces cannot be changed/);
  });

  it('saving the same slug, and changing anything else, is fine', async () => {
    expect(await outcome(w.system((tx) => tx.query(`UPDATE teams SET slug = slug, name = name WHERE id = $1`, [TEAM_IDS.Marketing])))).toBe('ok');
    expect(await outcome(w.system((tx) => tx.query(`UPDATE teams SET name = 'Marketing!' WHERE id = $1`, [TEAM_IDS.Marketing])))).toBe('ok');
    expect(await outcome(w.system((tx) => tx.query(`UPDATE workspaces SET name = name`)))).toBe('ok');
  });
});
