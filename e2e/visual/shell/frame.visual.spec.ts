import { test, expect } from '@playwright/test';
import {
  renderPlate, renderLive, comparePngs, landmarks, checkOrder, compareLandmarks,
  plateFrame, CLASS_P_LOOSE, type Landmark,
} from '../../../tools/plates/src/index.ts';


/*
 * `/?mock=1` vs [proto §02 plate 1 · Channel, with a thread open in the right panel], class P-loose,
 * "frame landmarks only" (PLAN Phase 1 §5). The plate has no data-landmark attributes, so its
 * regions are derived from layout inside `.frame .app`:
 *   team-switch = .side .team   search = .side .srch   sidebar = .side .nav
 *   header      = .main .chead  content = .main .stream
 * The pixel diff is computed and attached but NOT asserted: P-loose's 12% is meaningless
 * against an empty frame (the plate is a populated channel). Only presence and order are asserted.
 */
const PLATE_REGIONS: Record<string, string> = {
  'team-switch': '.side .team',
  search: '.side .srch',
  sidebar: '.side .nav',
  header: '.main .chead',
  content: '.main .stream',
};
const ORDER = ['team-switch', 'search', 'sidebar', 'header', 'content'];

test('empty frame has the plate landmarks in order', async ({ page }, testInfo) => {
  const plate = await renderPlate(page, 'app', 1);
  const frame = plateFrame(page, 'app', 1);
  const fb = (await frame.boundingBox())!;
  const expected: Landmark[] = [];
  for (const [name, sel] of Object.entries(PLATE_REGIONS)) {
    const box = await frame.locator(sel).first().boundingBox();
    expect(box, `plate region ${name}`).not.toBeNull();
    expected.push({ name, x: box!.x - fb.x, y: box!.y - fb.y, w: box!.width, h: box!.height });
  }
  // Sanity: the plate's own regions respect the order we then require of the live frame.
  expect(checkOrder(expected, ORDER)).toEqual([]);

  // A route with the shell's own header (the Threads home draws its own bands); mock mode (?mock=1) serves Omar from fixtures, so this spec has no server dependency.
  const live = await renderLive(page, '/t/engineering/files?mock=1');
  const actual = await landmarks(page);

  const diff = comparePngs(plate, live);
  await testInfo.attach('diff.png', { body: diff.diffPng, contentType: 'image/png' });
  await testInfo.attach('diff-ratio', { body: `${diff.diffRatio} (P-loose limit ${CLASS_P_LOOSE.maxDiffRatio}, informational)` });

  expect(checkOrder(actual, ORDER)).toEqual([]);
  // Presence of every plate-derived landmark (a huge tolerance checks presence only).
  expect(compareLandmarks(expected, actual, Infinity)).toEqual([]);
  expect(actual.map((l) => l.name)).not.toContain('missing');
});
