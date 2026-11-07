/**
 * A size in words for a sentence a person reads ("5 GB", "1.5 GB", "80 MB", "1000 bytes"), in the same 1024 steps as the Files screen. A whole number
 * has no decimal; below 10 of a unit one decimal is kept, so a small allowance is never rounded down to "0 GB".
 */
export function sizeInWords(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  const units: Array<[string, number]> = [
    ['GB', 1024 ** 3],
    ['MB', 1024 ** 2],
    ['KB', 1024],
  ];
  for (const [label, size] of units) {
    if (n < size) continue;
    const tenths = Math.round((n / size) * 10) / 10;
    return `${tenths >= 10 ? Math.round(n / size) : tenths} ${label}`;
  }
  return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
}
