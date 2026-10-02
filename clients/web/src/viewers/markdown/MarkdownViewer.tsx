import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import type { ViewerProps } from '../../kernel/viewers';
import { SaveFooter, ViewerBar, useSave } from '../common';
import { bodyToDoc, contentExtensions, docToText } from './codec';
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
  const [current, setCurrent] = useState(text);
  const [saved, setSaved] = useState(text);
  const saver = useSave(onSave);
  const programmatic = useRef(false);

  const editor = useEditor(
    {
      extensions: [...contentExtensions(), Markdown, SlashCommand],
      content: initial?.doc ?? '',
      editable: !readOnly,
      shouldRerenderOnTransaction: true,
      editorProps: { attributes: { class: 'md-prose', 'aria-label': 'Page content', role: 'textbox', 'aria-multiline': 'true' } },
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

  return (
    <div className="vw md" data-testid="viewer-markdown" data-mode={mode}>
      <ViewerBar path={path}>
        {!readOnly ? (
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

      <div className="md-editor" hidden={mode !== 'rich'}>
        <EditorContent editor={editor} />
        {frontmatter !== '' ? <p className="vw-note">This page has frontmatter. Use Raw to change it.</p> : null}
      </div>
      {mode === 'raw' ? (
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
