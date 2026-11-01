import { HttpError } from '@manythreads/sdk';

/**
 * How much of a team a person may call with role-group mentions (`@on-call`, P14-03). A group mention pings every holder, so one author could page a whole
 * team by pasting `@a @b @c` over and over. Two sliding windows per author and team, held in process memory like the other limits (per replica, never in
 * the database): at most `GROUPS_PER_MINUTE` group mentions in a minute and `PEOPLE_PER_HOUR` people reached in an hour. A message over the budget is
 * refused whole (429, plain sentence, nothing posted); only mentions that notify count (a group already named before an edit does not).
 *
 * A group mention counts when the message is accepted, even if the post later fails for another reason: a rolled-back message cannot be un-counted
 * because the counter lives outside the transaction. That errs on the side of the budget, which is the safe side.
 */
export const GROUPS_PER_MINUTE = 5;
export const PEOPLE_PER_HOUR = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

export interface MentionBudget {
  /** Counts one message's group mentions for `key`, or throws the 429. `groups` > 0 and `people` > 0 are what the message would notify. */
  take(key: string, groups: number, people: number): void;
  reset(): void;
}

export function createMentionBudget(now: () => number = Date.now): MentionBudget {
  const groupStamps = new Map<string, number[]>();
  const peopleStamps = new Map<string, Array<[number, number]>>();
  const fresh = <T>(list: T[], at: (item: T) => number, cutoff: number): T[] => list.filter((item) => at(item) > cutoff);
  return {
    take(key, groups, people) {
      const t = now();
      const g = fresh(groupStamps.get(key) ?? [], (s) => s, t - MINUTE);
      const p = fresh(peopleStamps.get(key) ?? [], (s) => s[0], t - HOUR);
      groupStamps.set(key, g);
      peopleStamps.set(key, p);
      if (g.length + groups > GROUPS_PER_MINUTE) {
        const wait = Math.max(1, Math.ceil(((g[0] ?? t) + MINUTE - t) / 1000));
        throw new HttpError(429, 'rate_limited', 'You used group mentions (a group, @channel or @here) too often: 5 a minute at most. Try again in a minute.', { 'retry-after': String(wait) });
      }
      const reached = p.reduce((sum, s) => sum + s[1], 0);
      if (reached + people > PEOPLE_PER_HOUR) {
        const wait = Math.max(1, Math.ceil(((p[0]?.[0] ?? t) + HOUR - t) / 1000));
        throw new HttpError(429, 'rate_limited', 'Your group mentions (a group, @channel or @here) have reached 1,000 people this hour, the most allowed. Try again later.', { 'retry-after': String(wait) });
      }
      for (let i = 0; i < groups; i++) g.push(t);
      p.push([t, people]);
    },
    reset() {
      groupStamps.clear();
      peopleStamps.clear();
    },
  };
}

/** The one budget of this process. */
export const mentionBudget: MentionBudget = createMentionBudget();
