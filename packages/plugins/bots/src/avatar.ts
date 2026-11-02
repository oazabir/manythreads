import { BOT_ANIMAL_AVATAR_PRESETS, BRAIN_BOT_SLUG, BRAIN_DEFAULT_AVATAR } from '@manythreads/shared';

// The picture a bot is given when its row is first created (PLAN P14-24): Brain gets the chip, every other bot a random animal. The loader asks once, for a
// row that does not exist yet; a reload of BOT.md never asks again, so a picture is never re-rolled and a choice a person made is never replaced.

/** The source of luck: a number in [0, 1), like `Math.random`. Tests replace it so the pick is exact. */
export type RandomSource = () => number;

let source: RandomSource = Math.random;

/** Swap the source of luck (tests); returns a function that puts the previous one back. */
export function setBotAvatarRandom(next: RandomSource): () => void {
  const previous = source;
  source = next;
  return () => {
    source = previous;
  };
}

/** `preset:<id>` for a new bot: Brain's chip, or one of the 19 animals (never a Brain picture). */
export function newBotAvatar(slug: string, random: RandomSource = source): string {
  if (slug === BRAIN_BOT_SLUG) return BRAIN_DEFAULT_AVATAR;
  const pool = BOT_ANIMAL_AVATAR_PRESETS;
  const drawn = random();
  const roll = Number.isFinite(drawn) ? Math.min(Math.max(drawn, 0), 0.999_999_999) : 0;
  return `preset:${pool[Math.floor(roll * pool.length)]!.id}`;
}
