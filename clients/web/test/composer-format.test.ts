import { describe, expect, it } from 'vitest';
import { codeBlock, codeSpan, insertText, linkSelection, prefixLines, wrapSelection } from '../src/channels/composerFormat';
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
