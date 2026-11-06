/*
 * Word error rate for the speech bench page (`/dev/speech`): how many words of the model's text differ from the words that were really said,
 * as a share of the real words. Case, punctuation and extra spaces do not count as differences.
 */

/** Lower-case words with the punctuation taken off; letters and digits of any alphabet stay, apostrophes inside a word stay. */
export function words(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}']+/gu, ' ')
    .replace(/(^|\s)'+|'+(?=\s|$)/g, '$1')
    .split(/\s+/)
    .filter(Boolean);
}

/** The fewest word swaps, drops and additions that turn `a` into `b`. */
export function editDistance(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const same = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + same);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/** Word error rate, 0 for a perfect match; null when there is no reference to compare with. Can pass 1 when the model adds words. */
export function wordErrorRate(reference: string, heard: string): number | null {
  const ref = words(reference);
  if (ref.length === 0) return null;
  return editDistance(ref, words(heard)) / ref.length;
}

/** Processing time as a share of the clip's length: 0.5 means a minute of speech takes thirty seconds. null for an empty clip. */
export function realTimeFactor(workMs: number, audioMs: number): number | null {
  return audioMs > 0 ? workMs / audioMs : null;
}
