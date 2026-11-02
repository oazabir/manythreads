import { z } from 'zod';

// Profile pictures (PLAN P14-23, library P14-24). A person or a bot shows one of three things: a picture from the built-in set, an uploaded photo (people only), or,
// when neither is chosen, their initials on a coloured disc. The stored value is one short text, so one column and one field carry all three cases.

/** Which built-in set an avatar belongs to: three for people, two for bots (the animals, and the pictures made for Brain). */
export const AvatarGroup = z.enum(['man', 'hijab', 'woman', 'bot', 'brain']);
export type AvatarGroup = z.infer<typeof AvatarGroup>;

export interface AvatarPreset {
  /** The id stored in `preset:<id>`; the picture is `/avatars/<id>.svg` (`.webp` for a retired one). Never renamed once released. */
  id: string;
  /** Plain words for the picture (its alt text and the picker's tooltip). */
  label: string;
  group: AvatarGroup;
  /** A picture of the first library (P14-23, WebP files). Anyone who chose one keeps it and it keeps drawing, but no picker offers it any more. */
  retired?: true;
}

const make = (group: AvatarGroup, items: readonly (readonly [string, string])[], retired?: true): AvatarPreset[] =>
  items.map(([id, label]) => (retired ? { id, label, group, retired } : { id, label, group }));

/**
 * The picture library (PLAN P14-24): 25 pictures for people, 19 animals and 6 Brain pictures for bots, in the order the picker shows them. The files are
 * `clients/web/public/avatars/<id>.svg`. People: DiceBear "Avataaars" (Pablo Stanley); animals: Google Noto Emoji (Apache 2.0); Brain: made for this project
 * (docs/third-party-assets.md). An id is never renamed once released.
 */
const CURRENT: readonly AvatarPreset[] = [
  ...make('man', [
    ['man-20-casual', 'Man in his 20s, casual, with a beard'],
    ['man-20-formal-muslim', 'Man in his 20s, formal, with a beard and a white cap'],
    ['man-20-formal-shaven', 'Man in his 20s, formal, clean-shaven'],
    ['man-30-casual-muslim', 'Man in his 30s, casual, with a beard and a white cap'],
    ['man-30-casual-shaven', 'Man in his 30s, casual, clean-shaven'],
    ['man-30-formal', 'Man in his 30s, formal, with a beard'],
    ['man-40-casual', 'Man in his 40s, casual, with a moustache'],
    ['man-40-formal-muslim', 'Man in his 40s, formal, with a beard and a white cap'],
    ['man-40-formal-shaven', 'Man in his 40s, formal, clean-shaven'],
    ['man-50-casual-muslim', 'Man in his 50s, casual, with glasses and a white cap'],
    ['man-50-casual-shaven', 'Man in his 50s, casual, with glasses, clean-shaven'],
    ['man-50-formal', 'Man in his 50s, formal, with glasses and a white beard'],
    ['man-60-casual', 'Man in his 60s, casual, bald with glasses'],
    ['man-60-formal-muslim', 'Man in his 60s, formal, with glasses and a white cap'],
    ['man-60-formal-shaven', 'Man in his 60s, formal, with glasses, clean-shaven'],
  ]),
  ...make('woman', [
    ['modest-20-formal', 'Woman in her 20s, formal'],
    ['modest-30-casual', 'Woman in her 30s, casual, with her hair up'],
    ['modest-40-formal', 'Woman in her 40s, formal, with long auburn hair'],
    ['modest-50-casual', 'Woman in her 50s, casual, with long grey hair and glasses'],
    ['modest-60-formal', 'Woman in her 60s, formal, with curly hair and glasses'],
  ]),
  ...make('hijab', [
    ['hijab-20-casual', 'Woman in her 20s with a pink hijab, casual'],
    ['hijab-30-formal', 'Woman in her 30s with a dark hijab, formal'],
    ['hijab-40-casual', 'Woman in her 40s with a light blue hijab, casual'],
    ['hijab-50-formal', 'Woman in her 50s with a white hijab and glasses, formal'],
    ['hijab-60-casual', 'Woman in her 60s with a white hijab and glasses, casual'],
  ]),
  ...make('bot', [
    ['bot-noto-bear', 'Bear'], ['bot-noto-cat', 'Cat'], ['bot-noto-chick', 'Chick'], ['bot-noto-cow', 'Cow'], ['bot-noto-dog', 'Dog'],
    ['bot-noto-dolphin', 'Dolphin'], ['bot-noto-duck', 'Duck'], ['bot-noto-fox', 'Fox'], ['bot-noto-frog', 'Frog'], ['bot-noto-hamster', 'Hamster'],
    ['bot-noto-koala', 'Koala'], ['bot-noto-lion', 'Lion'], ['bot-noto-monkey', 'Monkey'], ['bot-noto-mouse', 'Mouse'], ['bot-noto-panda', 'Panda'],
    ['bot-noto-rabbit', 'Rabbit'], ['bot-noto-sloth', 'Sloth'], ['bot-noto-t-rex', 'Dinosaur'], ['bot-noto-tiger', 'Tiger'],
  ]),
  ...make('brain', [
    ['bot-brain', 'Robot with a glass dome and a brain'], ['bot-brain-chip', 'Brain on a computer chip'], ['bot-brain-circuit', 'Robot with a circuit-pattern brain'],
    ['bot-brain-glow', 'Glowing robot with a pink brain'], ['bot-brain-neural', 'Purple robot with a network of dots'], ['bot-brain-orb', 'Floating orb with a brain'],
  ]),
];

/** The 40 pictures of the first library (P14-23, Flaticon). They stay valid and keep drawing; they are not offered and cannot be chosen again. */
const RETIRED: readonly AvatarPreset[] = [
  ...make('man', [
    ['man-1', 'Man with a beard'], ['man-2', 'Man in a purple shirt'], ['man-3', 'Man in a hooded jacket'], ['man-4', 'Man with curly hair'], ['man-5', 'Man in a yellow jacket'],
    ['man-6', 'Man with brown hair'], ['man-7', 'Man with glasses and a beard'], ['man-8', 'Man with a moustache'], ['man-9', 'Man in a suit'], ['man-10', 'Man with white hair and glasses'],
  ], true),
  ...make('hijab', [
    ['hijab-1', 'Woman in a pink hijab'], ['hijab-2', 'Woman in a dark hijab and glasses'], ['hijab-3', 'Woman in a long red hijab'], ['hijab-4', 'Woman in a pink scarf'], ['hijab-5', 'Smiling woman in a pink hijab'],
  ], true),
  ...make('woman', [
    ['woman-1', 'Woman with a ponytail'], ['woman-2', 'Woman with blond hair'], ['woman-3', 'Woman with dark hair'], ['woman-4', 'Woman with long hair'], ['woman-5', 'Woman with long brown hair'],
  ], true),
  ...make('bot', [
    ['bot-kitty-1', 'Happy kitten'], ['bot-kitty-2', 'Dancing kitten'], ['bot-laughing-cat', 'Laughing cat'], ['bot-unicorn-1', 'Cow-unicorn'], ['bot-puppy-1', 'Laughing puppy'],
    ['bot-puppy-2', 'Surprised puppy'], ['bot-unicorn-2', 'Crying unicorn'], ['bot-panda', 'Panda'], ['bot-fox-1', 'Orange fox'], ['bot-chick', 'Chick'],
    ['bot-penguin', 'Penguin'], ['bot-duck', 'Duck'], ['bot-gorilla', 'Gorilla'], ['bot-fox-2', 'Fox'], ['bot-dino', 'Dinosaur costume'],
    ['bot-cat', 'White cat'], ['bot-dog', 'Orange dog'], ['bot-bear', 'Bear'], ['bot-rabbit', 'Rabbit'], ['bot-lion', 'Lion'],
  ], true),
];

/** Every picture that can be drawn: the library and the retired first one. */
export const AVATAR_PRESETS: readonly AvatarPreset[] = [...CURRENT, ...RETIRED];

const BY_ID = new Map(AVATAR_PRESETS.map((p) => [p.id, p]));
export const avatarPreset = (id: string): AvatarPreset | undefined => BY_ID.get(id);

/** The 50 pictures the pickers offer. */
export const OFFERED_AVATAR_PRESETS: readonly AvatarPreset[] = CURRENT;
/** The pictures a person may choose (the three people sets) and the ones a bot may choose (the animals and the Brain pictures). */
export const PERSON_AVATAR_PRESETS: readonly AvatarPreset[] = CURRENT.filter((p) => p.group === 'man' || p.group === 'woman' || p.group === 'hijab');
export const BOT_AVATAR_PRESETS: readonly AvatarPreset[] = CURRENT.filter((p) => p.group === 'bot' || p.group === 'brain');
/** The 19 animals: the pool a new bot's random picture is drawn from. Never a Brain picture. */
export const BOT_ANIMAL_AVATAR_PRESETS: readonly AvatarPreset[] = CURRENT.filter((p) => p.group === 'bot');
/** What Brain is given when it is created (a workspace admin can change it). */
export const BRAIN_DEFAULT_AVATAR = 'preset:bot-brain-chip';
/** The slug of Brain, the one bot every team has. Only a workspace admin may change its picture. */
export const BRAIN_BOT_SLUG = 'brain';

/** An id from the people sets / the bot sets. A retired id is refused: it keeps drawing where it is stored but is never chosen again. */
const PERSON_IDS = new Set(PERSON_AVATAR_PRESETS.map((p) => p.id));
const BOT_IDS = new Set(BOT_AVATAR_PRESETS.map((p) => p.id));
export const PersonAvatarPresetId = z.string().refine((id) => PERSON_IDS.has(id), 'Choose one of the pictures in the list');
export const BotAvatarPresetId = z.string().refine((id) => BOT_IDS.has(id), 'Choose one of the bot pictures in the list');

/**
 * What is stored and sent: `preset:<id>` for a built-in picture, `photo:<16 hex>` for an uploaded photo (the hex is the start of the photo's hash, so a
 * new photo has a new address and the browser never shows an old one). `null` means neither: draw the initials.
 */
export const Avatar = z.string().regex(/^(preset:[a-z0-9-]{1,40}|photo:[0-9a-f]{16})$/, 'Not a profile picture');
export type Avatar = z.infer<typeof Avatar>;

/** Where the browser loads the picture from, or null when there is none to load (draw the initials). `personId` is needed for a photo. */
export function avatarSrc(avatar: string | null | undefined, personId?: string | null): string | null {
  if (!avatar) return null;
  if (avatar.startsWith('preset:')) {
    const id = avatar.slice(7);
    const preset = BY_ID.get(id);
    return preset ? `/avatars/${id}.${preset.retired ? 'webp' : 'svg'}` : null;
  }
  if (avatar.startsWith('photo:') && personId) return `/api/people/${personId}/avatar?v=${avatar.slice(6)}`;
  return null;
}

/** Plain words for a picture: the preset's label, "profile photo", or null for none. */
export function avatarLabel(avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  if (avatar.startsWith('photo:')) return 'Profile photo';
  return BY_ID.get(avatar.slice(7))?.label ?? null;
}

/** An uploaded photo is at most this many bytes. The browser shrinks a photo to a 256-pixel square first, which is far below it. */
export const AVATAR_PHOTO_MAX_BYTES = 262_144;
export const AVATAR_PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** The kinds of picture a photo may be (the CHECK of `person_photos.content_type`, same values in the same order). */
export const AvatarPhotoType = z.enum(AVATAR_PHOTO_TYPES);
export type AvatarPhotoType = z.infer<typeof AvatarPhotoType>;
