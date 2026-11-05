/** How many colour pairs an initials avatar can have (`--av-1` to `--av-10` in tokens.css). */
export const AVATAR_TONES = 10;

/** A stable tone 0 to 9 for a person or bot: a hash of its id (or name), so the same one always gets the same colour. */
export function toneOf(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return h % AVATAR_TONES;
}
