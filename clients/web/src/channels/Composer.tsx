import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { FileSummary } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { sendTyping, uploadChannelFile } from '../api/endpoints';
import { ClipIcon, CloseIcon, SendIcon } from '../shell/icons';
import { useDismiss } from '../shell/useDismiss';
import { CODE_LANGUAGES, codeBlock, codeSpan, insertText, linkSelection, prefixLines, wrapSelection, type Edit, type LineKind } from './composerFormat';
import { EmojiPicker } from './EmojiPicker';
import { fileSize } from './format';
import { MAX_UPLOAD_BYTES, TOO_LARGE, filesOf, useFilesSupport } from './files';
import { handleFor, type People } from './hooks';

/*
 * The shared composer (channel, thread, later DMs): markdown toolbar, Enter to send and Shift+Enter for a new line, a draft kept per
 * conversation, @ and # pickers, and attachments (upload with progress, paste, drag and drop, remove) when the server stores files.
 */

const DRAFT_PREFIX = 'manythreads.draft:';

function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}
function writeDraft(key: string, text: string): void {
  try {
    if (text === '') window.localStorage.removeItem(DRAFT_PREFIX + key);
    else window.localStorage.setItem(DRAFT_PREFIX + key, text);
  } catch {
    /* storage can be blocked: the draft then lives only in this tab */
  }
}

type Trigger = { char: '@' | '#'; query: string; start: number };

/** An `@` or `#` just before the caret that starts a word: what the picker completes. */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const m = /(^|[\s(])([@#])([\p{L}\p{N}_.-]{0,40})$/u.exec(text.slice(0, caret));
  if (!m) return null;
  const char = m[2] as '@' | '#';
  const query = m[3] ?? '';
  return { char, query, start: caret - query.length - 1 };
}

type Upload = {
  id: number;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
  file?: FileSummary;
  /** A local thumbnail URL of an image, drawn while it uploads; revoked with the row. */
  preview?: string;
  abort?: AbortController;
};

export type ComposerProps = {
  /** Where the draft is kept: one per channel or thread. */
  draftKey: string;
  placeholder: string;
  /** Names for the accessible label ("Message #dev"). */
  label: string;
  channelId: string;
  threadRootId: string | null;
  people: People;
  /** Channel names offered after `#`. */
  channelNames: readonly string[];
  /** Called with the text (and the files already uploaded); the caller shows the message at once and handles failure. */
  onSend: (body: string, attachments: FileSummary[]) => void;
  /** Focus the box when it appears (the thread panel). */
  autoFocus?: boolean;
  /** The Up arrow in an empty box: open the reader's last message of their own for editing (absent where there is nothing to edit). */
  onEditLast?: () => void;
};

export function Composer({ draftKey, placeholder, label, channelId, threadRootId, people, channelNames, onSend, autoFocus = false, onEditLast }: ComposerProps) {
  const filesOn = useFilesSupport(channelId);
  const [text, setText] = useState(() => readDraft(draftKey));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // the toolbar is one stop of the Tab key; the arrows move inside it (roving focus)
  const [toolAt, setToolAt] = useState(0);
  const tools = useRef<HTMLDivElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const emojiPop = useRef<HTMLDivElement>(null);
  // a press on the Emoji button or inside the picker is "inside" for dismissing; anywhere else closes it
  const emojiInside = useMemo(
    () => ({ get current() { return { contains: (n: Node | null) => (emojiButton.current?.contains(n) ?? false) || (emojiPop.current?.contains(n) ?? false) } as unknown as HTMLElement; } }),
    [],
  );
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const selection = useRef<[number, number] | null>(null);
  const draftFor = useRef(draftKey);
  const lastTyping = useRef(0);
  const typingOff = useRef(false);

  // A different conversation: its own draft, and nothing of the last one's files.
  useEffect(() => {
    if (draftFor.current === draftKey) return;
    draftFor.current = draftKey;
    setText(readDraft(draftKey));
    setUploads((list) => {
      list.forEach((u) => {
        u.abort?.abort();
        if (u.preview) URL.revokeObjectURL(u.preview);
      });
      return [];
    });
  }, [draftKey]);
  useEffect(() => {
    const t = setTimeout(() => writeDraft(draftFor.current, text), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => () => writeDraft(draftFor.current, area.current?.value ?? ''), []);
  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus, threadRootId]);
  useEffect(
    () => () =>
      uploadsRef.current.forEach((u) => {
        u.abort?.abort();
        if (u.preview) URL.revokeObjectURL(u.preview);
      }),
    [],
  );
  const uploadsRef = useRef(uploads);
  useEffect(() => {
    uploadsRef.current = uploads;
  });

  // grow with the text, up to about eight lines
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    // not on screen (a hidden composer measures 0): leave it at its own one-line height
    el.style.height = el.scrollHeight > 0 ? `${Math.min(el.scrollHeight, 188)}px` : '';
  }, [text]);
  useLayoutEffect(() => {
    const el = area.current;
    const sel = selection.current;
    if (el && sel) {
      el.setSelectionRange(sel[0], sel[1]);
      selection.current = null;
    }
  });

  const trigger = useMemo(() => detectTrigger(text, caret), [text, caret]);
  const items = useMemo(() => {
    if (!trigger || dismissed === trigger.start) return [];
    const q = trigger.query.toLowerCase();
    if (trigger.char === '@') {
      return people.list
        .filter((p) => q === '' || p.name.toLowerCase().includes(q) || handleFor(p, people.list).startsWith(q))
        .slice(0, 6)
        .map((p) => ({ key: p.personId, label: p.name, hint: `@${handleFor(p, people.list)}`, insert: `@${handleFor(p, people.list)} ` }));
    }
    return channelNames
      .filter((n) => q === '' || n.toLowerCase().includes(q))
      .slice(0, 6)
      .map((n) => ({ key: n, label: `#${n}`, hint: '', insert: `#${n} ` }));
  }, [trigger, dismissed, people, channelNames]);
  const open = items.length > 0;
  const active = Math.min(pick, Math.max(0, items.length - 1));

  const edit = useCallback((next: string, from: number, to = from): void => {
    setText(next);
    setCaret(to);
    selection.current = [from, to];
    area.current?.focus();
  }, []);

  /** Runs one of the pure text edits on the box's current text and selection, and puts the caret where it says. */
  const apply = (fn: (t: string, a: number, b: number) => Edit): void => {
    const el = area.current;
    if (!el) return;
    const r = fn(text, el.selectionStart, el.selectionEnd);
    edit(r.text, r.from, r.to);
  };
  const wrap = (before: string, after: string, fallback: string): void => apply((t, a, b) => wrapSelection(t, a, b, before, after, fallback));
  const lines = (kind: LineKind): void => apply((t, a, b) => prefixLines(t, a, b, kind));
  const block = (lang: string): void => apply((t, a, b) => codeBlock(t, a, b, lang));
  const putEmoji = (char: string): void => {
    setEmojiOpen(false);
    apply((t, a, b) => insertText(t, a, b, char));
  };
  const mark = (char: '@' | '#'): void => {
    const el = area.current;
    if (!el) return;
    const a = el.selectionStart;
    const lead = a > 0 && !/\s/.test(text[a - 1] ?? ' ') ? ' ' : '';
    edit(`${text.slice(0, a)}${lead}${char}${text.slice(el.selectionEnd)}`, a + lead.length + 1);
  };
  const choose = (i: number): void => {
    const it = items[i];
    if (!it || !trigger) return;
    const next = `${text.slice(0, trigger.start)}${it.insert}${text.slice(caret)}`;
    edit(next, trigger.start + it.insert.length);
    setPick(0);
  };

  // ---- attachments --------------------------------------------------------------------------------------------
  const addFiles = (files: File[]): void => {
    if (!filesOn) return;
    for (const file of files) {
      const id = nextId.current++;
      // an image shows its own thumbnail from the moment it is added, from the local bytes: no wait for the upload
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploads((l) => [...l, { id, name: file.name, size: file.size, progress: 0, status: 'error', error: TOO_LARGE, preview }]);
        continue;
      }
      const abort = new AbortController();
      setUploads((l) => [...l, { id, name: file.name, size: file.size, progress: 0, status: 'uploading', preview, abort }]);
      uploadChannelFile(channelId, file, (f) => setUploads((l) => l.map((u) => (u.id === id ? { ...u, progress: f } : u))), abort.signal).then(
        (meta) => setUploads((l) => l.map((u) => (u.id === id ? { ...u, status: 'done', progress: 1, name: meta.name, file: { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime } } : u))),
        (e: unknown) => {
          if (abort.signal.aborted) return;
          const tooBig = isApiError(e) && e.status === 413;
          setUploads((l) => l.map((u) => (u.id === id ? { ...u, status: 'error', error: tooBig ? TOO_LARGE : e instanceof Error ? e.message : 'Upload failed' } : u)));
        },
      );
    }
  };
  const removeUpload = (id: number): void =>
    setUploads((l) => {
      const gone = l.find((u) => u.id === id);
      gone?.abort?.abort();
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return l.filter((u) => u.id !== id);
    });

  const uploading = uploads.some((u) => u.status === 'uploading');
  const ready = uploads.flatMap((u) => (u.status === 'done' && u.file ? [u.file] : []));
  const canSend = !uploading && (text.trim() !== '' || ready.length > 0);

  const send = (): void => {
    if (!canSend) return;
    // a message of only files has no text of its own: the server wants one character, so it carries the file names
    const body = text.trim() !== '' ? text.trim() : ready.map((f) => f.name).join(', ');
    onSend(body, ready);
    uploads.forEach((u) => {
      if (u.preview) URL.revokeObjectURL(u.preview);
    });
    setText('');
    setUploads([]);
    setCaret(0);
    writeDraft(draftFor.current, '');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPick((active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(active);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(trigger?.start ?? null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      send();
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 'b' || e.key.toLowerCase() === 'i')) {
      e.preventDefault();
      if (e.key.toLowerCase() === 'b') wrap('**', '**', 'bold');
      else wrap('*', '*', 'italic');
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      wrap('~~', '~~', 'strike');
    } else if (e.key === 'ArrowUp' && onEditLast && text === '' && uploads.length === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      onEditLast();
    }
  };

  // ---- the toolbar: one tab stop, the arrows move along it ---------------------------------------------------
  const toolControls = (): HTMLElement[] => [...(tools.current?.querySelectorAll<HTMLElement>('button.ctool, select.ctool') ?? [])];
  const onToolsKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key) || e.target instanceof HTMLSelectElement) return;
    const list = toolControls();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (at < 0 || list.length === 0) return;
    e.preventDefault();
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    setToolAt(to);
    list[to]?.focus();
  };
  const tab = (i: number): { tabIndex: number; onFocus: () => void } => ({ tabIndex: i === toolAt ? 0 : -1, onFocus: () => setToolAt(i) });
  useDismiss(emojiOpen, () => {
    setEmojiOpen(false);
    area.current?.focus();
  }, emojiInside);

  const onChange = (value: string, at: number): void => {
    setText(value);
    setCaret(at);
    setPick(0);
    const now = Date.now();
    if (value.trim() !== '' && !typingOff.current && now - lastTyping.current > 3_000) {
      lastTyping.current = now;
      // best effort: a server that does not know typing (404) is not asked again
      sendTyping(channelId, threadRootId).catch((err: unknown) => {
        if (isApiError(err) && err.status === 404) typingOff.current = true;
      });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = filesOf(e.clipboardData.files);
    if (files.length > 0 && filesOn) {
      e.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (e: DragEvent): void => {
    setDrag(false);
    const files = filesOf(e.dataTransfer.files);
    if (files.length > 0 && filesOn) {
      e.preventDefault();
      addFiles(files);
    }
  };

  return (
    <div
      className={`composer ${drag ? 'dragging' : ''} ${text === '' && uploads.length === 0 ? 'resting' : ''}`}
      data-testid="composer"
      data-landmark={threadRootId ? 'reply-composer' : 'composer'}
      onDragOver={(e) => {
        if (filesOn && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      <div className="cbox">
        <div className="ctools" role="toolbar" aria-label="Formatting" ref={tools} onKeyDown={onToolsKey}>
          <button type="button" className="ctool" aria-label="Bold" title="Bold (Ctrl+B)" onClick={() => wrap('**', '**', 'bold')} {...tab(0)}><b>B</b></button>
          <button type="button" className="ctool" aria-label="Italic" title="Italic (Ctrl+I)" onClick={() => wrap('*', '*', 'italic')} {...tab(1)}><i>I</i></button>
          <button type="button" className="ctool" aria-label="Strikethrough" title="Strikethrough (Ctrl+Shift+X)" onClick={() => wrap('~~', '~~', 'strike')} {...tab(2)}><s>S</s></button>
          <button type="button" className="ctool mono" aria-label="Code" title="Code" onClick={() => apply((t, a, b) => codeSpan(t, a, b))} {...tab(3)}>{'</>'}</button>
          <select
            className="ctool ctool-select"
            aria-label="Insert a code block"
            title="Code block"
            value=""
            onChange={(e) => {
              block(e.target.value === '-' ? '' : e.target.value);
              e.target.value = '';
            }}
            {...tab(4)}
          >
            <option value="" disabled>Code block</option>
            {CODE_LANGUAGES.map((l) => (
              <option key={l.label} value={l.lang === '' ? '-' : l.lang}>{l.label}</option>
            ))}
          </select>
          <button type="button" className="ctool" aria-label="Quote" title="Quote" onClick={() => lines('quote')} {...tab(5)}>&gt;</button>
          <button type="button" className="ctool" aria-label="Bulleted list" title="Bulleted list" onClick={() => lines('bullet')} {...tab(6)}>≡</button>
          <button type="button" className="ctool" aria-label="Numbered list" title="Numbered list" onClick={() => lines('number')} {...tab(7)}>1.</button>
          <button type="button" className="ctool" aria-label="Link" title="Link" onClick={() => apply(linkSelection)} {...tab(8)}>↗</button>
          <button type="button" className="ctool" aria-label="Mention a person" title="Mention" onClick={() => mark('@')} {...tab(9)}>@</button>
          <button type="button" className="ctool" aria-label="Link a channel" title="Channel" onClick={() => mark('#')} {...tab(10)}>#</button>
          <button
            ref={emojiButton}
            type="button"
            className="ctool"
            aria-label="Emoji"
            title="Emoji"
            aria-haspopup="dialog"
            aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen((o) => !o)}
            {...tab(11)}
          >
            <span aria-hidden="true">☺</span>
          </button>
        </div>
        {emojiOpen ? (
          <div ref={emojiPop} className="emp-pop">
            <EmojiPicker onPick={putEmoji} onClose={() => { setEmojiOpen(false); area.current?.focus(); }} />
          </div>
        ) : null}
        {uploads.length > 0 ? (
          <ul className="cfiles" aria-label="Attachments">
            {uploads.map((u) => (
              <li key={u.id} className={`cfile ${u.preview ? 'image' : ''} ${u.status}`} data-testid="upload" data-status={u.status}>
                {u.preview ? <img src={u.preview} alt="" className="cfile-preview" /> : null}
                <span className="cfile-name">{u.name}</span>
                <span className="cfile-size">{fileSize(u.size)}</span>
                {u.status === 'uploading' ? (
                  <span className="cfile-bar" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)}>
                    <span style={{ width: `${Math.round(u.progress * 100)}%` }} />
                  </span>
                ) : null}
                {u.status === 'uploading' ? <span className="cfile-pct" data-vt-mask>{`${Math.round(u.progress * 100)}%`}</span> : null}
                {u.status === 'error' ? <span className="cfile-error" role="alert">{u.error}</span> : null}
                <button type="button" className="icon-btn" aria-label={`Remove ${u.name}`} onClick={() => removeUpload(u.id)}><CloseIcon /></button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="cinput">
          {open ? (
            <ul className="picker" role="listbox" aria-label={trigger?.char === '@' ? 'People' : 'Channels'}>
              {items.map((it, i) => (
                <li key={it.key} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); choose(i); }}>
                  <span>{it.label}</span>
                  {it.hint ? <small>{it.hint}</small> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={open}
            onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {filesOn ? (
            <>
              <input ref={fileInput} type="file" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(e) => { addFiles(filesOf(e.target.files)); e.target.value = ''; }} />
              <button type="button" className="icon-btn clip" aria-label="Attach a file" title="Attach a file" onClick={() => fileInput.current?.click()}><ClipIcon /></button>
            </>
          ) : null}
          <button type="button" className="btn primary send" aria-label="Send" disabled={!canSend} onClick={send}><SendIcon /><span>Send</span></button>
        </div>
      </div>
    </div>
  );
}
