import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import { tickInPage } from '@manythreads/shared';
import type { ViewerProps } from '../../kernel/viewers';
import { SaveFooter, ViewerBar, useSave } from '../common';
import { bodyToDoc, contentExtensions, docToText } from './codec';
import { LivePageEditor } from './LivePageEditor';
import { SlashCommand } from './slash';

/** Pages above this size open as raw text: the parser is not built for books, and a rich editor would stall. */
export const RICH_LIMIT = 200_000;

/**
 * Markdown page: Tiptap WYSIWYG with a `/` menu (table among them) and a Raw toggle. The text of the file stays the source
 * of truth: untouched pages keep their bytes, an edit re-serialises the body once, the frontmatter is never rewritten.
 */
export default function MarkdownViewer({ path, text = '', readOnly, onSave, context }: ViewerProps) {
  const big = text.length > RICH_LIMIT;
  const initial = useMemo(() => (big ? null : bodyToDoc(text)), [text, big]);
  const frontmatter = initial?.frontmatter ?? '';
  const [mode, setMode] = useState<'rich' | 'raw'>(big ? 'raw' : 'rich');
  const [live, setLive] = useState(false);
  const [current, setCurrent] = useState(text);
  const [saved, setSaved] = useState(text);
  const saver = useSave(onSave);
  const programmatic = useRef(false);
  // A click on a checklist box (see `tickBox` below). The editor is made once, so it reads the current handler through this ref.
  const tickRef = useRef<((nth: number, checked: boolean, boxes: number, text: string) => boolean) | null>(null);

  const editor = useEditor(
    {
      extensions: [...contentExtensions(), Markdown, SlashCommand],
      content: initial?.doc ?? '',
      editable: !readOnly,
      shouldRerenderOnTransaction: true,
      editorProps: {
        attributes: { class: 'md-prose', 'aria-label': 'Page content', role: 'textbox', 'aria-multiline': 'true' },
        handleDOMEvents: {
          click: (view, event) => {
            const box = event.target;
            if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox') return false;
            const item = box.closest('li[data-checked]');
            const items = Array.from(view.dom.querySelectorAll('li[data-checked]'));
            const nth = item === null ? -1 : items.indexOf(item);
            if (nth < 0 || tickRef.current === null) return false;
            // the box already shows its new state while the click is handled
            // the words of the item as the editor shows them (its content area, not the hidden label of the box), so the tick is matched on text as well as number
            const text = item?.querySelector(':scope > div')?.textContent ?? '';
            if (!tickRef.current(nth, box.checked, items.length, text)) return false;
            event.preventDefault();
            return true;
          },
        },
      },
      onUpdate: ({ editor: ed, transaction }) => {
        if (!transaction.docChanged || programmatic.current) return;
        setCurrent(docToText(frontmatter, ed.getJSON()));
        saver.reset();
      },
    },
    [],
  );

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  const toRaw = () => setMode('raw');
  const toRich = () => {
    if (!editor || big) return;
    // the raw text may have changed: show it (the editor must not report that as an edit)
    const next = bodyToDoc(current);
    programmatic.current = true;
    editor.commands.setContent(next.doc, { emitUpdate: false });
    programmatic.current = false;
    setMode('rich');
  };

  const dirty = current !== saved;
  const doSave = async () => {
    if (await saver.save(current)) setSaved(current);
  };
  // Ticking a box of a task list on a page that has no other unsaved change writes the `[x]` or `[ ]` back to the page's own text and saves it: one
  // character of the source changes, the rest of the page keeps its bytes, and the save is a commit like any other edit, with the person as author.
  // Anything else (unsaved edits, live editing, a box the text and the editor count differently) is left to the editor and the Save button.
  const tickBox = (nth: number, checked: boolean, boxes: number, text: string): boolean => {
    if (readOnly || live || mode !== 'rich' || dirty || saver.status === 'saving') return false;
    const next = tickInPage(current, nth, checked, boxes, text);
    if (next === null || next === current) return false;
    void (async () => {
      if (!(await saver.save(next))) return;
      setCurrent(next);
      setSaved(next);
      if (editor && !big) {
        programmatic.current = true;
        editor.commands.setContent(bodyToDoc(next).doc, { emitUpdate: false });
        programmatic.current = false;
      }
    })();
    return true;
  };
  useEffect(() => {
    tickRef.current = tickBox;
  });
  // Leaving live editing: the server has committed the source, so the viewer shows exactly that text (no refetch, no second save).
  const leaveLive = (finalText: string) => {
    setLive(false);
    setCurrent(finalText);
    setSaved(finalText);
    setMode(big ? 'raw' : 'rich');
    const next = bodyToDoc(finalText);
    if (editor && !big) {
      programmatic.current = true;
      editor.commands.setContent(next.doc, { emitUpdate: false });
      programmatic.current = false;
    }
  };

  return (
    <div className="vw md" data-testid="viewer-markdown" data-mode={mode}>
      <ViewerBar path={path}>
        {!readOnly && !live ? (
          <button
            type="button"
            className="btn sm"
            data-testid="go-live"
            disabled={dirty || big}
            title={dirty ? 'Save or discard your edit before editing together' : big ? 'Large files are edited as raw text' : 'Edit with others, with live cursors'}
            onClick={() => setLive(true)}
          >
            Live
          </button>
        ) : null}
        {!readOnly && !live ? (
          <button type="button" className="btn primary sm" disabled={!dirty || saver.status === 'saving'} onClick={() => void doSave()}>
            {saver.status === 'saving' ? 'Saving…' : 'Save'}
          </button>
        ) : null}
        <button type="button" className="btn sm" aria-pressed={mode === 'raw'} disabled={big} title={big ? 'Large file: edit as raw text' : undefined} onClick={mode === 'raw' ? toRich : toRaw}>
          Raw
        </button>
      </ViewerBar>

      {mode === 'rich' && editor && !readOnly ? (
        <div className="md-toolbar" role="toolbar" aria-label="Formatting">
          <button type="button" className="tb" aria-label="Bold" aria-pressed={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></button>
          <button type="button" className="tb" aria-label="Italic" aria-pressed={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
          <button type="button" className="tb" aria-label="Strikethrough" aria-pressed={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></button>
          <button type="button" className="tb mono" aria-label="Code" aria-pressed={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>{'</>'}</button>
          <span className="tb-hint">Type / for blocks</span>
        </div>
      ) : null}

      {live ? <LivePageEditor path={path} teamSlug={context.teamSlug} onExit={leaveLive} /> : null}
      <div className="md-editor" hidden={mode !== 'rich' || live}>
        <EditorContent editor={editor} />
        {frontmatter !== '' ? <p className="vw-note">This page starts with a block of settings. Use Raw to change it.</p> : null}
      </div>
      {mode === 'raw' && !live ? (
        <textarea
          className="md-raw"
          aria-label="Raw Markdown"
          spellCheck={false}
          value={current}
          readOnly={readOnly}
          onChange={(e) => {
            setCurrent(e.target.value);
            saver.reset();
          }}
        />
      ) : null}
      <SaveFooter authorName={context.authorName} status={saver.status} message={saver.message} readOnly={readOnly} />
    </div>
  );
}
