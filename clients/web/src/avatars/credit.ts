import { AVATAR_PRESETS } from '@manythreads/shared';

/** The credit the licences ask for (docs/third-party-assets.md): who made the pictures on offer, and the first library's maker while someone still has one of its pictures. */
export function creditLine(person: boolean, current: string | null): string {
  const parts = person
    ? ['People pictures: Avataaars by Pablo Stanley, through DiceBear.']
    : ['Animal pictures: Noto Emoji by Google (Apache License 2.0). Brain pictures: made for manythreads.'];
  if (current?.startsWith('preset:') && AVATAR_PRESETS.some((p) => p.retired === true && `preset:${p.id}` === current)) parts.push('Earlier pictures by Flaticon.');
  return parts.join(' ');
}
