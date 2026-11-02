import { describe, expect, it } from 'vitest';
import { countTaskItems, setTaskChecked, taskItemAt, tickInPage } from '../src/text/tasklist.ts';

describe('task-list boxes in the source text', () => {
  const src = ['# Plan', '- [ ] a', '```', '- [ ] in code', '```', '- [x] b', '> - [ ] quoted', '* [ ] c  '].join('\n');

  it('counts boxes in order, outside fenced code, including a quoted one', () => {
    expect(countTaskItems(src)).toBe(4);
    expect(taskItemAt(src, 0)).toMatchObject({ checked: false, text: 'a', line: 1 });
    expect(taskItemAt(src, 1)).toMatchObject({ checked: true, text: 'b' });
    expect(taskItemAt(src, 2)).toMatchObject({ checked: false, text: 'quoted' });
    expect(taskItemAt(src, 3)).toMatchObject({ text: 'c' });
    expect(taskItemAt(src, 4)).toBeNull();
  });

  it('changes one character and nothing else', () => {
    const ticked = setTaskChecked(src, 0, true);
    expect(ticked).toBe(src.replace('- [ ] a', '- [x] a'));
    expect(setTaskChecked(src, 2, true)).toBe(src.replace('> - [ ] quoted', '> - [x] quoted'));
    expect(setTaskChecked(src, 1, false)).toBe(src.replace('- [x] b', '- [ ] b'));
    expect(setTaskChecked(src, 9, true)).toBe(src);
  });

  it('keeps Windows line ends and trailing spaces as they were', () => {
    const crlf = '- [ ] one\r\n- [ ] two\r\n';
    expect(setTaskChecked(crlf, 1, true)).toBe('- [ ] one\r\n- [x] two\r\n');
    expect(taskItemAt(crlf, 0)?.text).toBe('one');
  });

  it('counts nested boxes only when asked, as a page does', () => {
    const page = ['- [ ] top', '  - [ ] child', '    - [x] grandchild', '- [ ] next'].join('\n');
    // the chat reads up to three spaces of indent as the same list, so only the deeper line is left out
    expect(countTaskItems(page)).toBe(3);
    expect(countTaskItems(page, { nested: true })).toBe(4);
    expect(setTaskChecked(page, 1, true, { nested: true })).toBe(page.replace('  - [ ] child', '  - [x] child'));
    expect(taskItemAt(page, 2, { nested: true })).toMatchObject({ checked: true, text: 'grandchild' });
  });

  it('does not read a numbered item, a link or a plain bracket as a box', () => {
    const text = ['1. [ ] numbered', '- [link](http://x.y)', '- [] empty', '- [ ]nospace', 'text - [ ] mid'].join('\n');
    expect(countTaskItems(text)).toBe(0);
    expect(countTaskItems(text, { nested: true })).toBe(0);
  });

  it('is linear on hostile input', () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => (i % 3 === 0 ? '- [ ] item' : `${' '.repeat(i % 50)}>>>> ${'`'.repeat(3)}`)).join('\n');
    const started = performance.now();
    countTaskItems(lines, { nested: true });
    setTaskChecked(lines, 10_000, true, { nested: true });
    const long = `${' '.repeat(200_000)}x`;
    countTaskItems(long, { nested: true });
    countTaskItems(`${'> '.repeat(100_000)}- [ ] x`, { nested: true });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('the scanner agrees with the renderer on lines', () => {
  it('closes a fence that was opened inside a block quote, so the box after it counts', () => {
    const text = ['> ```', '> - [ ] in quoted code', '> ```', '- [ ] real'].join('\n');
    expect(countTaskItems(text)).toBe(1);
    expect(taskItemAt(text, 0)?.text).toBe('real');
    // a quoted fence also ends where the quote ends
    const open = ['> ```', '> - [ ] in code', '- [ ] after the quote'].join('\n');
    expect(taskItemAt(open, 0)?.text).toBe('after the quote');
  });

  it('reads a lone carriage return as a line end, as the chat does, and keeps the bytes it did not touch', () => {
    const text = '- [ ] one\r- [ ] two\r\n- [ ] three\n- [ ] four';
    expect(countTaskItems(text)).toBe(4);
    expect(taskItemAt(text, 1)?.text).toBe('two');
    expect(setTaskChecked(text, 1, true)).toBe('- [ ] one\r- [x] two\r\n- [ ] three\n- [ ] four');
  });

  it('ignores the characters the chat strips, and still changes the right character', () => {
    const text = '- [\u202e \u2066] marked\n- [ ] \u0007plain';
    expect(countTaskItems(text)).toBe(2);
    expect(taskItemAt(text, 1)?.text).toBe('plain');
    expect(setTaskChecked(text, 0, true)).toBe('- [\u202ex\u2066] marked\n- [ ] \u0007plain');
    // a line separator inside a line is not a line end
    expect(countTaskItems('- [ ] a\u2028- [ ] b')).toBe(1);
  });
});

describe('tickInPage (a tick in the page viewer, as a pure function)', () => {
  const page = ['---', 'title: Plan', 'todo:', '- [ ] not a box', '---', '# Plan', '- [ ] **write** the `test`', '  - [ ] child', '- [x] ship'].join('\n');

  it('ticks the matching box, leaving front matter and every other byte alone', () => {
    const next = tickInPage(page, 0, true, 3, 'write the test');
    expect(next).toBe(page.replace('- [ ] **write**', '- [x] **write**'));
    expect(tickInPage(page, 1, true, 3, 'child')).toBe(page.replace('  - [ ] child', '  - [x] child'));
    expect(tickInPage(page, 2, false, 3, 'ship')).toBe(page.replace('- [x] ship', '- [ ] ship'));
  });

  it('declines when the counts differ, the words differ, or the box is already in that state', () => {
    expect(tickInPage(page, 0, true, 4, 'write the test')).toBeNull();
    expect(tickInPage(page, 0, true, 3, 'something else')).toBeNull();
    expect(tickInPage(page, 2, true, 3, 'ship')).toBeNull();
    expect(tickInPage(page, 7, true, 3, 'ship')).toBeNull();
  });

  it('does not count a box in indented code or a fence as a page box', () => {
    const doc = ['- [ ] real', '', '```', '- [ ] code', '```'].join('\n');
    expect(tickInPage(doc, 0, true, 1, 'real')).toBe(doc.replace('- [ ] real', '- [x] real'));
    expect(tickInPage(doc, 0, true, 2, 'real')).toBeNull();
  });
});

