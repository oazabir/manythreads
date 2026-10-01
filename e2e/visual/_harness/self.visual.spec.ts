import { test, expect } from '@playwright/test';
import { renderPlate, comparePngs } from '../../../tools/plates/src/index.ts';


// A plate against itself: rendering twice must give 0 differing pixels.
test('plate §02 #1 equals itself', async ({ page }) => {
  const a = await renderPlate(page, 'app', 1);
  const b = await renderPlate(page, 'app', 1);
  expect(a.length).toBeGreaterThan(1000);
  const r = comparePngs(a, b);
  expect(r.diffPixels).toBe(0);
});
