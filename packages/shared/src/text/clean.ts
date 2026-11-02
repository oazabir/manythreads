/**
 * The text as it may be drawn: no control characters (except newline, carriage return and tab), no bidirectional overrides or isolates (they reorder what a
 * reader sees: `txt.exe` shown as `exe.txt`), no line or paragraph separators, no byte-order mark. The joiners emoji and some scripts need stay.
 * The chat draws text only after this, and the task-list scanner counts boxes the same way, so a box has the same number in both.
 */
// eslint-disable-next-line no-control-regex
export const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff\ufff9-\ufffb]/g;
export const cleanText = (text: string): string => text.replace(UNSAFE_CHARS, '');
