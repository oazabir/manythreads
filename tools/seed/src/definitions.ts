// The saved starting points of the persona journeys (PLAN P12-02, Bundle E decision E29). A journey names one of these and the harness restores it.
//
//   day-1   a workspace on its first day: the seven people, the three teams carrying their templates, and each team's repository with the default bots
//           (seed v2 + v4, no chat history). What Omar finds right after the install.
//   week-2  the same workspace after two weeks of use: channels with history, a thread, a private channel, a DM, the team repositories' pages, files and memory,
//           the Engineering board with its cards and Bot Board, and three finished calls (seeds v2, v3, v4, v6 and v15). What every other journey reads.
//
// The recipe is data so the hash (hash.ts) and the builder (build.ts) read one thing.

export const SNAPSHOT_NAMES = ['day-1', 'week-2'] as const;
export type SnapshotName = (typeof SNAPSHOT_NAMES)[number];

export interface SnapshotRecipe {
  /** One sentence for `snapshot list`. */
  describes: string;
  /** Seed v3: channels, messages, a thread, a private channel, a DM, a 5,000-message channel. */
  content: boolean;
  /** Seed v4: each team repository's pages, files, memory and bot placeholders. */
  repo: boolean;
  /** Seed v6: the Engineering board, Bot Board, routines and the protected environment. */
  work: boolean;
  /** Seed v15: three finished calls made through the real routes (needs the meeting stand-ins). */
  meetings: boolean;
}

export const RECIPES: Record<SnapshotName, SnapshotRecipe> = {
  'day-1': { describes: 'first day: people, teams from templates, default bots, no history', content: false, repo: true, work: false, meetings: false },
  'week-2': { describes: 'two weeks in: channels with history, repositories, board, three finished calls', content: true, repo: true, work: true, meetings: true },
};

export function isSnapshotName(value: string): value is SnapshotName {
  return (SNAPSHOT_NAMES as readonly string[]).includes(value);
}

/** A readable list for an error message. */
export const SNAPSHOT_LIST = SNAPSHOT_NAMES.join(', ');
