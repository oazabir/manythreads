import { z } from 'zod';

// Profile pictures (PLAN P14-23). A person or a bot shows one of three things: a picture from the built-in set, an uploaded photo (people only), or,
// when neither is chosen, their initials on a coloured disc. The stored value is one short text, so one column and one field carry all three cases.

/** Which built-in set an avatar belongs to: three for people, one for bots. */
export const AvatarGroup = z.enum(['man', 'hijab', 'woman', 'bot']);
export type AvatarGroup = z.infer<typeof AvatarGroup>;

export interface AvatarPreset {
  /** The id stored in `preset:<id>`; the picture is `/avatars/<id>.webp`. Never renamed once released. */
  id: string;
  /** Plain words for the picture (its alt text and the picker's tooltip). */
  label: string;
  group: AvatarGroup;
}

const make = (group: AvatarGroup, items: readonly (readonly [string, string])[]): AvatarPreset[] => items.map(([id, label]) => ({ id, label, group }));

/** The built-in pictures, in the order the picker shows them. Pictures: Flaticon (docs/third-party-assets.md). */
export const AVATAR_PRESETS: readonly AvatarPreset[] = [
  ...make('man', [
    ['man-1', 'Man with a beard'], ['man-2', 'Man in a purple shirt'], ['man-3', 'Man in a hooded jacket'], ['man-4', 'Man with curly hair'], ['man-5', 'Man in a yellow jacket'],
    ['man-6', 'Man with brown hair'], ['man-7', 'Man with glasses and a beard'], ['man-8', 'Man with a moustache'], ['man-9', 'Man in a suit'], ['man-10', 'Man with white hair and glasses'],
  ]),
  ...make('hijab', [
    ['hijab-1', 'Woman in a pink hijab'], ['hijab-2', 'Woman in a dark hijab and glasses'], ['hijab-3', 'Woman in a long red hijab'], ['hijab-4', 'Woman in a pink scarf'], ['hijab-5', 'Smiling woman in a pink hijab'],
  ]),
  ...make('woman', [
    ['woman-1', 'Woman with a ponytail'], ['woman-2', 'Woman with blond hair'], ['woman-3', 'Woman with dark hair'], ['woman-4', 'Woman with long hair'], ['woman-5', 'Woman with long brown hair'],
  ]),
  ...make('bot', [
    ['bot-kitty-1', 'Happy kitten'], ['bot-kitty-2', 'Dancing kitten'], ['bot-laughing-cat', 'Laughing cat'], ['bot-unicorn-1', 'Cow-unicorn'], ['bot-puppy-1', 'Laughing puppy'],
    ['bot-puppy-2', 'Surprised puppy'], ['bot-unicorn-2', 'Crying unicorn'], ['bot-panda', 'Panda'], ['bot-fox-1', 'Orange fox'], ['bot-chick', 'Chick'],
    ['bot-penguin', 'Penguin'], ['bot-duck', 'Duck'], ['bot-gorilla', 'Gorilla'], ['bot-fox-2', 'Fox'], ['bot-dino', 'Dinosaur costume'],
    ['bot-cat', 'White cat'], ['bot-dog', 'Orange dog'], ['bot-bear', 'Bear'], ['bot-rabbit', 'Rabbit'], ['bot-lion', 'Lion'],
  ]),
];

const BY_ID = new Map(AVATAR_PRESETS.map((p) => [p.id, p]));
export const avatarPreset = (id: string): AvatarPreset | undefined => BY_ID.get(id);

/** The pictures a person may choose (the three people sets) and the ones a bot may choose. */
export const PERSON_AVATAR_PRESETS: readonly AvatarPreset[] = AVATAR_PRESETS.filter((p) => p.group !== 'bot');
export const BOT_AVATAR_PRESETS: readonly AvatarPreset[] = AVATAR_PRESETS.filter((p) => p.group === 'bot');

/** An id from the people sets / the bot set. */
export const PersonAvatarPresetId = z.string().refine((id) => BY_ID.get(id) !== undefined && BY_ID.get(id)!.group !== 'bot', 'Choose one of the pictures in the list');
export const BotAvatarPresetId = z.string().refine((id) => BY_ID.get(id)?.group === 'bot', 'Choose one of the bot pictures in the list');

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
    return BY_ID.has(id) ? `/avatars/${id}.webp` : null;
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
