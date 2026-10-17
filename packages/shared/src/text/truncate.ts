// Shared text truncation (single implementation): cut to `max` UTF-16 units,
// never splitting a surrogate pair. `clip`/`clipText` end with an ellipsis;
// `headOf` is the same head without one.

/** `text` cut to `max` with an ellipsis, never between the two halves of a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, Math.max(0, end))}…`;
}

/** Alias of `clip`: `text` cut to `max` UTF-16 units with an ellipsis. */
export const clipText = clip;

/** The same head without an ellipsis: `text` cut to `max`, whole code points only. */
export function headOf(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, Math.max(0, end));
}
