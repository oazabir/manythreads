import type { Unit } from './segment.ts';
import { clipText, headOf } from '../text/index.ts';

export const SNIPPET = 400;
export { headOf };

/**
 * The text of one block without the units that are hit. A removed marker at a boundary takes the unit before it, a unit that is hit takes the
 * unit before it when its own split was doubtful (and so on back: soft splits chain), and `forceLast` (a marker-only block follows) takes the
 * last unit.
 */
export function assembleBlock(text: string, units: Unit[], forceLast: boolean): { text: string; dropped: string[]; any: boolean } {
  for (let u = 1; u < units.length; u += 1) {
    if (units[u]!.boundary) units[u - 1]!.hit = true;
  }
  if (forceLast && units.length > 0) units[units.length - 1]!.hit = true;
  for (let u = units.length - 1; u >= 1; u -= 1) {
    if (units[u]!.hit && units[u]!.soft) units[u - 1]!.hit = true;
  }
  let any = false;
  let out = '';
  const dropped: string[] = [];
  for (const unit of units) {
    if (unit.hit) {
      any = true;
      const said = text.slice(unit.start, unit.end).replace(/\s+/g, ' ').trim();
      if (said !== '') dropped.push(clipText(said, SNIPPET));
    } else {
      out += text.slice(unit.start, unit.end);
    }
  }
  return { text: out, dropped, any };
}
