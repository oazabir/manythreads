import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tabWalk, tabWalkProblems } from '../tabwalk.ts';
import { closeBrowser, launch, screen, serve, type Served } from './browser.ts';

const opened: Served[] = [];
beforeAll(async () => {
  await launch();
}, 120_000);
afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.close();
});
afterAll(closeBrowser);

const open = async (body: string): Promise<Served> => {
  const served = await serve(screen(body, { ready: null }));
  opened.push(served);
  return served;
};

describe('tabWalk', () => {
  it('starts at the top of the page even when a box in the middle has the cursor (the Chat screen focuses its message box at once)', async () => {
    const { page } = await open('<a href="#a">First link</a><a href="#b">Second link</a><textarea id="t" aria-label="Message Brain" autofocus></textarea><a href="#c">Last link</a>');
    await page.evaluate(() => document.getElementById('t')!.focus());
    const stops = await tabWalk(page, { max: 10 });
    expect(stops.map((s) => s.name)).toEqual(['First link', 'Second link', 'Message Brain', 'Last link']);
  }, 30_000);

  it('skips the page itself as a stop instead of ending the walk', async () => {
    // a tabindex=-1 element that gives the focus back to the page when it is focused leaves activeElement on the body between two real stops
    const { page } = await open('<a href="#a" id="a">One</a><a href="#b" id="b" onfocus="document.activeElement.blur()">Gives focus away</a><a href="#c" id="c">Three</a>');
    const stops = await tabWalk(page, { max: 10 });
    expect(stops.map((s) => s.name)).toEqual(['One', 'Three']);
  }, 30_000);

  it('names a control by its label: for=, a wrapping label (its own text left out), aria-labelledby, aria-label', async () => {
    const { page } = await open(
      '<label for="p">Search people</label><input id="p" type="search">' +
        '<label>From <input type="number"></label>' +
        '<label>Group <select><option>Everything</option></select></label>' +
        '<span id="n">Named elsewhere</span><button aria-labelledby="n"></button>' +
        '<button aria-label="Close"></button>' +
        '<input type="text" id="nameless">',
    );
    const stops = await tabWalk(page, { max: 10 });
    expect(stops.map((s) => s.name)).toEqual(['Search people', 'From', 'Group', 'Named elsewhere', 'Close', '']);
    expect(tabWalkProblems(stops).filter((p) => p.includes('no name'))).toEqual(['stop 6 (input) has no name for a screen reader']);
  }, 30_000);

  it('stops when the walk comes round to the first stop', async () => {
    const { page } = await open('<a href="#a">One</a><a href="#b">Two</a>');
    const stops = await tabWalk(page, { max: 50 });
    expect(stops.map((s) => s.name)).toEqual(['One', 'Two']);
  }, 30_000);

  it('starts from a given element', async () => {
    const { page } = await open('<a href="#a" class="skip">Skip</a><a href="#b">Next</a>');
    const stops = await tabWalk(page, { max: 5, from: 'a.skip' });
    expect(stops[0]?.name).toBe('Next');
  }, 30_000);
});
