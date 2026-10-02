import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';

export type SlashItem = {
  id: string;
  title: string;
  hint: string;
  /** Extra words the filter matches (`h1`, `ul`). */
  keywords: string[];
  run: (editor: Editor, range: Range) => void;
};

const at = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'h1', title: 'Heading 1', hint: 'Big section title', keywords: ['h1', 'title'], run: (e, r) => at(e, r).setNode('heading', { level: 1 }).run() },
  { id: 'h2', title: 'Heading 2', hint: 'Section title', keywords: ['h2'], run: (e, r) => at(e, r).setNode('heading', { level: 2 }).run() },
  { id: 'h3', title: 'Heading 3', hint: 'Small section title', keywords: ['h3'], run: (e, r) => at(e, r).setNode('heading', { level: 3 }).run() },
  { id: 'bullets', title: 'Bulleted list', hint: 'A simple list', keywords: ['ul', 'list', 'bullet'], run: (e, r) => at(e, r).toggleBulletList().run() },
  { id: 'numbers', title: 'Numbered list', hint: 'An ordered list', keywords: ['ol', 'list', 'number'], run: (e, r) => at(e, r).toggleOrderedList().run() },
  { id: 'tasks', title: 'Task list', hint: 'Checkboxes', keywords: ['todo', 'check', 'task'], run: (e, r) => at(e, r).toggleTaskList().run() },
  { id: 'quote', title: 'Quote', hint: 'Set a passage apart', keywords: ['blockquote'], run: (e, r) => at(e, r).toggleBlockquote().run() },
  { id: 'code', title: 'Code block', hint: 'Monospaced text', keywords: ['pre', 'fence'], run: (e, r) => at(e, r).toggleCodeBlock().run() },
  { id: 'divider', title: 'Divider', hint: 'A horizontal rule', keywords: ['hr', 'rule', 'line'], run: (e, r) => at(e, r).setHorizontalRule().run() },
  { id: 'table', title: 'Table', hint: '3 by 3 with a header row', keywords: ['grid', 'rows'], run: (e, r) => at(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
];

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return SLASH_ITEMS;
  return SLASH_ITEMS.filter((i) => i.title.toLowerCase().includes(q) || i.keywords.some((k) => k.startsWith(q)));
}

/** The menu is plain DOM next to the cursor (a popover over the editor); keyboard: arrows, Enter or Tab, Escape. */
function menuRenderer() {
  let el: HTMLDivElement | null = null;
  let items: SlashItem[] = [];
  let index = 0;
  let command: ((item: SlashItem) => void) | null = null;

  const draw = () => {
    if (!el) return;
    el.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'slash-empty';
      empty.textContent = 'No matching blocks';
      el.append(empty);
      return;
    }
    items.forEach((item, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slash-item';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(i === index));
      b.dataset['slash'] = item.id;
      const t = document.createElement('span');
      t.className = 'slash-title';
      t.textContent = item.title;
      const h = document.createElement('span');
      h.className = 'slash-hint';
      h.textContent = item.hint;
      b.append(t, h);
      b.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        command?.(item);
      });
      el?.append(b);
    });
  };
  const place = (props: SuggestionProps<SlashItem>) => {
    const rect = props.clientRect?.();
    if (!el || !rect) return;
    const host = el.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
    el.style.left = `${Math.max(0, rect.left - host.left)}px`;
    el.style.top = `${rect.bottom - host.top + 4}px`;
  };
  return {
    onStart(props: SuggestionProps<SlashItem>) {
      el = document.createElement('div');
      el.className = 'slash-menu';
      el.setAttribute('role', 'listbox');
      el.setAttribute('aria-label', 'Insert block');
      el.dataset['testid'] = 'slash-menu';
      el.setAttribute('data-testid', 'slash-menu');
      (props.editor.view.dom.closest('.md-editor') ?? document.body).append(el);
      items = props.items;
      index = 0;
      command = (item) => props.command(item);
      draw();
      place(props);
    },
    onUpdate(props: SuggestionProps<SlashItem>) {
      items = props.items;
      index = Math.min(index, Math.max(0, items.length - 1));
      command = (item) => props.command(item);
      draw();
      place(props);
    },
    onKeyDown({ event }: SuggestionKeyDownProps) {
      if (event.key === 'Escape') {
        el?.remove();
        el = null;
        return true;
      }
      if (items.length === 0) return false;
      if (event.key === 'ArrowDown') index = (index + 1) % items.length;
      else if (event.key === 'ArrowUp') index = (index - 1 + items.length) % items.length;
      else if (event.key === 'Enter' || event.key === 'Tab') {
        const item = items[index];
        if (item) command?.(item);
        return true;
      } else return false;
      draw();
      return true;
    },
    onExit() {
      el?.remove();
      el = null;
    },
  };
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        items: ({ query }) => filterSlashItems(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: menuRenderer,
      }),
    ];
  },
});
