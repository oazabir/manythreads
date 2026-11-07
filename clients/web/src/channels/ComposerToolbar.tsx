import { useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useMenuKeys } from '../shell/RowMenu';
import {
  ToolBoldIcon, ToolBulletIcon, ToolChannelIcon, ToolCodeBlockIcon, ToolCodeIcon, ToolEmojiIcon, ToolFormatIcon, ToolItalicIcon, ToolLinkIcon, ToolMentionIcon,
  ToolMoreIcon, ToolNumberIcon, ToolPollIcon, ToolQuoteIcon, ToolStrikeIcon,
} from '../shell/icons';
import { useDismiss } from '../shell/useDismiss';
import { CODE_LANGUAGES } from './composerFormat';
import { TOOL_CHORDS, barTools, chordText, moreTools, toolTitle, type ToolId, type ToolLayout } from './composerTools';

/*
 * The formatting bar above the message box (PLAN P21-04). It is always there, so the list above never moves when the box gets focus; the icons are 16 px and the
 * tooltips name the shortcut. In a narrow box (the thread panel) the rarer tools sit under "…"; on a phone one "Aa" button opens the row. The bar is one stop
 * of the Tab key and the arrows move along it.
 */

type Icon = ComponentType<{ size?: number }>;
const UI: Record<ToolId, { aria: string; title: string; Icon: Icon; mono?: boolean }> = {
  bold: { aria: 'Bold', title: 'Bold', Icon: ToolBoldIcon },
  italic: { aria: 'Italic', title: 'Italic', Icon: ToolItalicIcon },
  strike: { aria: 'Strikethrough', title: 'Strikethrough', Icon: ToolStrikeIcon },
  code: { aria: 'Code', title: 'Code', Icon: ToolCodeIcon },
  codeblock: { aria: 'Insert a code block', title: 'Code block', Icon: ToolCodeBlockIcon },
  quote: { aria: 'Quote', title: 'Quote', Icon: ToolQuoteIcon },
  bullet: { aria: 'Bulleted list', title: 'Bulleted list', Icon: ToolBulletIcon },
  number: { aria: 'Numbered list', title: 'Numbered list', Icon: ToolNumberIcon },
  link: { aria: 'Link', title: 'Link', Icon: ToolLinkIcon },
  mention: { aria: 'Mention a person', title: 'Mention', Icon: ToolMentionIcon },
  channel: { aria: 'Link a channel', title: 'Channel', Icon: ToolChannelIcon },
  emoji: { aria: 'Emoji', title: 'Emoji', Icon: ToolEmojiIcon },
  poll: { aria: 'Ask a poll', title: 'Poll', Icon: ToolPollIcon },
};

const chordFor = (id: ToolId, mac: boolean): string | null => {
  const chord = TOOL_CHORDS[id];
  return chord ? chordText(chord, mac) : null;
};

export function ComposerToolbar({ layout, tools, mac, onRun, onCodeBlock, emojiOpen, emojiRef }: {
  layout: ToolLayout;
  /** The tools this box offers, in order (no poll where polls make no sense). */
  tools: readonly ToolId[];
  mac: boolean;
  onRun: (id: ToolId) => void;
  onCodeBlock: (lang: string) => void;
  emojiOpen: boolean;
  emojiRef: RefObject<HTMLButtonElement | null>;
}) {
  const [formatOpen, setFormatOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toolAt, setToolAt] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const morePanel = useRef<HTMLDivElement>(null);
  const shown = barTools(layout, tools, formatOpen);
  const rest = moreTools(layout, tools);
  const slots: string[] = [...(layout === 'aa' ? ['format'] : []), ...shown, ...(rest.length > 0 ? ['more'] : [])];
  const at = Math.min(toolAt, Math.max(0, slots.length - 1));
  const tab = (key: string): { tabIndex: number; onFocus: () => void } => {
    const i = slots.indexOf(key);
    return { tabIndex: i === at ? 0 : -1, onFocus: () => setToolAt(i) };
  };

  const moreInside = useMemo(
    () => ({ get current() { return { contains: (n: Node | null) => (moreButton.current?.contains(n) ?? false) || (morePanel.current?.contains(n) ?? false) } as unknown as HTMLElement; } }),
    [],
  );
  const closeMore = (): void => {
    if (morePanel.current?.contains(document.activeElement)) moreButton.current?.focus();
    setMoreOpen(false);
  };
  useDismiss(moreOpen, closeMore, moreInside);
  const moreKeys = useMenuKeys(moreOpen, morePanel, closeMore);

  const controls = (): HTMLElement[] => [...(bar.current?.querySelectorAll<HTMLElement>('button.ctool, select.ctool') ?? [])];
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key) || e.target instanceof HTMLSelectElement) return;
    const list = controls();
    const from = list.indexOf(document.activeElement as HTMLElement);
    if (from < 0 || list.length === 0) return;
    e.preventDefault();
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (from + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    setToolAt(to);
    list[to]?.focus();
  };

  const button = (id: ToolId): ReactNode => {
    const ui = UI[id];
    const Glyph = ui.Icon;
    if (id === 'codeblock') {
      return (
        <span key={id} className="ctool-sel" title={toolTitle(ui.title, id, mac)}>
          <span className="ctool-sel-icon" aria-hidden="true"><Glyph /></span>
          <select
            className="ctool ctool-select"
            aria-label={ui.aria}
            value=""
            onChange={(e) => {
              onCodeBlock(e.target.value === '-' ? '' : e.target.value);
              e.target.value = '';
            }}
            {...tab(id)}
          >
            <option value="" disabled>Code block</option>
            {CODE_LANGUAGES.map((l) => (
              <option key={l.label} value={l.lang === '' ? '-' : l.lang}>{l.label}</option>
            ))}
          </select>
        </span>
      );
    }
    return (
      <button
        key={id}
        ref={id === 'emoji' ? emojiRef : undefined}
        type="button"
        className="ctool"
        aria-label={ui.aria}
        title={toolTitle(ui.title, id, mac)}
        {...(id === 'emoji' ? { 'aria-haspopup': 'dialog' as const, 'aria-expanded': emojiOpen } : {})}
        {...(id === 'poll' ? { 'aria-haspopup': 'dialog' as const, 'data-testid': 'poll-tool' } : {})}
        onClick={() => onRun(id)}
        {...tab(id)}
      >
        <Glyph />
      </button>
    );
  };

  return (
    <>
      <div className={`ctools ${layout}`} role="toolbar" aria-label="Formatting" ref={bar} onKeyDown={onKey} data-testid="composer-tools" data-layout={layout}>
        {layout === 'aa' ? (
          <button
            type="button"
            className="ctool"
            aria-label="Formatting options"
            title="Formatting options"
            aria-pressed={formatOpen}
            data-testid="composer-format-toggle"
            onClick={() => setFormatOpen((o) => !o)}
            {...tab('format')}
          >
            <ToolFormatIcon />
          </button>
        ) : null}
        {shown.map(button)}
        {rest.length > 0 ? (
          <button
            ref={moreButton}
            type="button"
            className="ctool"
            aria-label="More formatting"
            title="More formatting"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            data-testid="composer-more"
            onClick={() => setMoreOpen((o) => !o)}
            {...tab('more')}
          >
            <ToolMoreIcon />
          </button>
        ) : null}
      </div>
      {moreOpen ? (
        <div ref={morePanel} className="ctools-more" role="menu" aria-label="More formatting" onKeyDown={moreKeys} data-testid="composer-more-menu">
          {rest.map((id) => {
            const ui = UI[id];
            const Glyph = ui.Icon;
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                className="ctools-more-item"
                data-testid={`composer-more-${id}`}
                onClick={() => {
                  setMoreOpen(false);
                  if (id === 'codeblock') onCodeBlock('');
                  else onRun(id);
                }}
              >
                <Glyph />
                <span>{id === 'codeblock' ? 'Code block' : ui.aria}</span>
                {chordFor(id, mac) ? <kbd>{chordFor(id, mac)}</kbd> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
