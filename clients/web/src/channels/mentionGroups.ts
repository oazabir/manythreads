import { useEffect, useState } from 'react';
import type { MentionGroup } from '@manythreads/shared';
import { fetchMentionGroups } from '../api/endpoints';
import { onPersonChange } from '../app/caches';
import { useSession } from '../app/session';

/**
 * The role groups of a team (`@on-call`) as the `@` picker offers them (P14-03). They come from the server per conversation, because the number beside a
 * group is how many people a mention reaches there (holders of the tag who can read the channel), and one answer is kept for a minute so a thread panel or a
 * second box does not ask again. Nothing is fetched until the person types an `@`; a failed or empty answer means the picker simply shows no groups.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; load: Promise<MentionGroup[]> }>();

/** One answer is per person and channel: the same channel answers differently to two people (who can read it, who they are), and a sign-out drops them all. */
export const mentionGroupsKey = (personId: string, channelId: string): string => `${personId}:${channelId}`;

function groupsOf(personId: string, channelId: string, now = Date.now()): Promise<MentionGroup[]> {
  const key = mentionGroupsKey(personId, channelId);
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.load;
  const load = fetchMentionGroups(channelId).then(
    (r) => r.groups,
    () => {
      cache.delete(key);
      return [] as MentionGroup[];
    },
  );
  cache.set(key, { at: now, load });
  return load;
}

/** Forget what was kept (a test, or a role change the person just made). */
export function resetMentionGroups(): void {
  cache.clear();
}

// When the person changes or signs out, what was kept for the last one goes (see app/caches.ts).
onPersonChange(resetMentionGroups);

export function useMentionGroups(channelId: string, wanted: boolean): readonly MentionGroup[] {
  const personId = useSession().person.id;
  const [shown, setShown] = useState<{ key: string; groups: readonly MentionGroup[] }>({ key: '', groups: [] });
  const key = mentionGroupsKey(personId, channelId);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void groupsOf(personId, channelId).then((g) => live && setShown({ key, groups: g }));
    return () => {
      live = false;
    };
  }, [personId, channelId, key, wanted]);
  // An answer for another channel or person is never shown: moving to a new channel starts with no groups until its own answer arrives.
  return shown.key === key ? shown.groups : [];
}

/** The groups a typed query finds: the handle starts with it, or contains it once there are two letters. Best matches first, at most `limit`. */
export function matchGroups(groups: readonly MentionGroup[], query: string, limit = 3): MentionGroup[] {
  const q = query.toLowerCase();
  const starts = groups.filter((g) => g.handle.startsWith(q));
  const inside = q.length >= 2 ? groups.filter((g) => !g.handle.startsWith(q) && g.handle.includes(q)) : [];
  return [...starts, ...inside].slice(0, limit);
}

/** "1 person", "4 people": what the picker says beside a group. */
export function groupCountText(count: number): string {
  return count === 1 ? '1 person' : `${count} people`;
}
