import { describe, expect, it } from 'vitest';
import { COMPOSER_MAX_HEIGHT, codeBlock, codeSpan, enterKey, insideCodeBlock, insertText, linkSelection, prefixLines, wrapSelection } from '../src/channels/composerFormat';
import { lastEditableOwn } from '../src/channels/messageActions';
import { parseMarkdown } from '../src/channels/markdown';

const apply = (r: { text: string; from: number; to: number }): string => `${r.text.slice(0, r.from)}[${r.text.slice(r.from, r.to)}]${r.text.slice(r.to)}`;

describe('wrapSelection', () => {
  it('wraps the selection, and writes a word to type over when nothing is selected', () => {
    expect(apply(wrapSelection('make this bold', 5, 9, '**', '**', 'bold'))).toBe('make **[this]** bold');
    expect(apply(wrapSelection('', 0, 0, '~~', '~~', 'strike'))).toBe('~~[strike]~~');
  });

  it('takes the marks off again, whether they sit inside the selection or just around it', () => {
    expect(apply(wrapSelection('make **this** bold', 5, 13, '**', '**', 'bold'))).toBe('make [this] bold');
    expect(apply(wrapSelection('make **this** bold', 7, 11, '**', '**', 'bold'))).toBe('make [this] bold');
  });
});

describe('codeSpan and codeBlock', () => {
  it('makes inline code for one line and a fenced block for several', () => {
    expect(apply(codeSpan('run ls now', 4, 6))).toBe('run `[ls]` now');
    expect(apply(codeSpan('a\nb', 0, 3))).toBe('```\n[a\nb]\n```');
  });

  it('writes the language after the opening fence and starts on its own line', () => {
    expect(apply(codeBlock('', 0, 0, 'ts'))).toBe('```ts\n[code]\n```');
    expect(apply(codeBlock('see:', 4, 4, 'python'))).toBe('see:\n```python\n[code]\n```');
    expect(apply(codeBlock('x = 1', 0, 5, 'js'))).toBe('```js\n[x = 1]\n```');
  });

  it('is read back as a code block with that language', () => {
    const edit = codeBlock('', 0, 0, 'ts');
    expect(parseMarkdown(edit.text)).toEqual([{ t: 'code', lang: 'ts', v: 'code' }]);
  });
});

describe('prefixLines', () => {
  it('starts a bullet on an empty box, like the button always did', () => {
    expect(prefixLines('', 0, 0, 'bullet')).toEqual({ text: '- ', from: 2, to: 2 });
  });

  it('marks every line the selection touches, numbering from 1', () => {
    expect(prefixLines('one\ntwo\nthree', 2, 9, 'bullet').text).toBe('- one\n- two\n- three');
    expect(prefixLines('one\ntwo', 0, 7, 'number').text).toBe('1. one\n2. two');
    expect(prefixLines('one\ntwo', 0, 7, 'quote').text).toBe('> one\n> two');
  });

  it('takes the marks off when every line has them, and swaps one kind for another', () => {
    expect(prefixLines('- one\n- two', 0, 11, 'bullet').text).toBe('one\ntwo');
    expect(prefixLines('1. one\n2. two', 0, 13, 'number').text).toBe('one\ntwo');
    expect(prefixLines('- one\n- two', 0, 11, 'number').text).toBe('1. one\n2. two');
    expect(prefixLines('> one', 0, 5, 'quote').text).toBe('one');
  });

  it('leaves the lines outside the selection alone', () => {
    expect(prefixLines('keep\nthis\nkeep', 5, 9, 'quote').text).toBe('keep\n> this\nkeep');
  });

  it('is read back as the same lists and quotes', () => {
    expect(parseMarkdown(prefixLines('a\nb', 0, 3, 'number').text)).toEqual([{ t: 'list', ordered: true, items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]] }]);
    expect(parseMarkdown(prefixLines('a', 0, 1, 'quote').text)[0]).toMatchObject({ t: 'quote' });
  });
});

describe('linkSelection', () => {
  it('makes the selected words the text and leaves the address to type', () => {
    expect(apply(linkSelection('see docs', 4, 8))).toBe('see [docs]([https://])');
  });

  it('makes a selected address the target', () => {
    expect(apply(linkSelection('go https://example.com now', 3, 22))).toBe('go [[link]](https://example.com) now');
  });

  it('writes both placeholders with nothing selected, and undoes a finished link', () => {
    expect(linkSelection('', 0, 0).text).toBe('[link text](https://)');
    expect(apply(linkSelection('[docs](https://x.dev)', 0, 21))).toBe('[docs]');
  });

  it('is read back as a link', () => {
    const edit = linkSelection('', 0, 0);
    expect(parseMarkdown(edit.text.replace('https://', 'https://example.com'))[0]).toMatchObject({ t: 'p', c: [{ t: 'link', href: 'https://example.com' }] });
  });
});

describe('insertText', () => {
  it('writes over the selection and puts the caret after it', () => {
    expect(insertText('ab', 1, 1, '😀')).toEqual({ text: 'a😀b', from: 3, to: 3 });
    expect(insertText('abc', 0, 3, 'x')).toEqual({ text: 'x', from: 1, to: 1 });
  });
});

describe('lastEditableOwn', () => {
  const m = (id: string, authorId: string, over: Record<string, unknown> = {}) => ({ id, authorId, deletedAt: null, meta: {}, ...over });

  it('finds the newest message of the reader that can still be edited', () => {
    const items = [m('1', 'me'), m('2', 'me'), m('3', 'them'), m('4', 'me', { deletedAt: '2026-10-29T00:00:00Z' }), m('5', 'me', { meta: { answer: {} } })];
    expect(lastEditableOwn(items, 'me')).toBe('2');
  });

  it('answers null with nothing of their own, or when nobody is signed in', () => {
    expect(lastEditableOwn([m('1', 'them')], 'me')).toBeNull();
    expect(lastEditableOwn([m('1', 'me')], null)).toBeNull();
    expect(lastEditableOwn([], 'me')).toBeNull();
  });
});

describe('edge cases of the toggles', () => {
  it('italic on bold text adds a mark instead of turning bold into italic', () => {
    expect(apply(wrapSelection('say **this** now', 6, 10, '*', '*', 'italic'))).toBe('say ***[this]*** now');
    expect(apply(wrapSelection('say **this** now', 4, 12, '*', '*', 'italic'))).toBe('say *[**this**]* now');
    expect(apply(wrapSelection('say *this* now', 5, 9, '*', '*', 'italic'))).toBe('say [this] now');
  });

  it('leaves two separate bold spans alone instead of fusing them', () => {
    expect(apply(wrapSelection('**a** and **b**', 0, 15, '**', '**', 'bold'))).toBe('**[**a** and **b**]**');
  });

  it('a caret on the first, empty line starts that line', () => {
    expect(apply(prefixLines('\nabc', 0, 0, 'bullet'))).toBe('- []\nabc');
  });

  it('a selection that ends just after a line break does not reach the next line', () => {
    expect(apply(prefixLines('one\ntwo\nthree', 0, 8, 'quote'))).toBe('[> one\n> two]\nthree');
  });
});

describe('the message box height (P21-28)', () => {
  it('grows to 376 px, the number channels.css gives .cinput textarea', () => {
    expect(COMPOSER_MAX_HEIGHT).toBe(376);
  });
});

describe('Enter in the message box (P34-03)', () => {
  const plain = { shift: false, ctrl: false, meta: false, alt: false };
  /** Enter at the end of `text`; the answer drawn with the caret as `|`. */
  const at = (text: string, caret = text.length, keys = plain): string => {
    const r = enterKey(text, caret, caret, keys);
    return r.do === 'edit' ? `${r.edit.text.slice(0, r.edit.from)}|${r.edit.text.slice(r.edit.to)}` : r.do;
  };

  it('sends outside a list or a code block', () => {
    expect(at('hello')).toBe('send');
    expect(at('')).toBe('send');
    expect(at('a - b')).toBe('send');
    expect(at('1.5 kg')).toBe('send');
    expect(at('**bold**')).toBe('send');
  });
  it('leaves Shift+Enter and Alt+Enter to the browser, and sends on Ctrl or Cmd with Enter from anywhere', () => {
    expect(at('hello', 5, { ...plain, shift: true })).toBe('default');
    expect(at('hello', 5, { ...plain, alt: true })).toBe('default');
    expect(at('- one', 5, { ...plain, ctrl: true })).toBe('send');
    expect(at('```\nx', 5, { ...plain, meta: true })).toBe('send');
    expect(at('- one', 5, { ...plain, shift: true })).toBe('default');
  });
  it('starts the next item of a list, at the same indent and with the same mark', () => {
    expect(at('- one')).toBe('- one\n- |');
    expect(at('* one')).toBe('* one\n* |');
    expect(at('+ one')).toBe('+ one\n+ |');
    expect(at('intro\n  - nested')).toBe('intro\n  - nested\n  - |');
    expect(at('- [x] done')).toBe('- [x] done\n- [ ] |');
  });
  it('numbers the next item', () => {
    expect(at('1. first')).toBe('1. first\n2. |');
    expect(at('1. first\n2. second')).toBe('1. first\n2. second\n3. |');
    expect(at('9) ninth')).toBe('9) ninth\n10) |');
  });
  it('splits an item where the caret is', () => {
    expect(at('- one two', 5)).toBe('- one\n- | two');
  });
  it('ends the list on an empty item: the mark goes, nothing is sent', () => {
    expect(at('- one\n- ')).toBe('- one\n|');
    expect(at('1. a\n2. ')).toBe('1. a\n|');
    expect(at('- one\n  - ')).toBe('- one\n|');
  });
  it('leaves a plain new line to the browser when the caret is before the mark (Ctrl+Z undoes it)', () => {
    expect(at('- one', 0)).toBe('default');
  });
  it('writes a new line inside an open code block and sends after it is closed', () => {
    // inside a block the browser writes the new line itself, so Ctrl+Z undoes it
    expect(at('```')).toBe('default');
    expect(at('```ts\nconst a = 1')).toBe('default');
    expect(at('look:\n```\n- not a list')).toBe('default');
    expect(at('```\ncode\n```')).toBe('send');
    expect(insideCodeBlock('```\ncode\n```\nafter', 18)).toBe(false);
    expect(insideCodeBlock('```\ncode', 6)).toBe(true);
  });
  it('a one-line fence opens nothing, and only the same fence closes a block (review)', () => {
    expect(at('```npm i```')).toBe('send');
    expect(at('```npm i```\nmore')).toBe('send');
    expect(insideCodeBlock('~~~\n```\nstill code', 18)).toBe(true);
    expect(insideCodeBlock('~~~\n```\n~~~\n', 13)).toBe(false);
  });
  it('a year at the start of a sentence is not a list item (review)', () => {
    expect(at('2024. was good')).toBe('send');
    expect(at('12. twelfth')).not.toBe('send');
  });
  it('replaces a selection with the new item', () => {
    const r = enterKey('- one two', 5, 9, plain);
    expect(r).toEqual({ do: 'edit', edit: { text: '- one\n- ', from: 8, to: 8 }, replace: { start: 5, end: 9, insert: '\n- ' } });
  });
});
