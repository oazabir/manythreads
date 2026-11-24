import { useCallback, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import {
  ToolBoldIcon, ToolBulletIcon, ToolChannelIcon, ToolCodeBlockIcon, ToolCodeIcon, ToolEmojiIcon, ToolItalicIcon, ToolLinkIcon, ToolMentionIcon, ToolNumberIcon,
  ToolQuoteIcon, ToolStrikeIcon,
} from '../shell/icons';
import { CODE_LANGUAGES } from './composerFormat';
import { TOOL_ORDER, scrollEdges, toolTitle, type BarToolId } from './composerTools';

/*
 * The formatting bar above the message box (PLAN P21-04). Since P36-09 it is shown only when the person chose "Show formatting" in the Attach menu, and then
 * stays (it never folds on focus, so the list above never moves under a press); the icons are 16 px and the tooltips name the shortcut. Every composer
 * (channel, thread panel, direct message, Brain chat) draws the same tools in the same order (P34-03); a box too narrow for one row wraps to a second, and a
 * phone scrolls it sideways. The bar is one stop of the Tab key and the arrows move along it.
 */

type Icon = ComponentType<{ size?: number }>;
const UI: Record<BarToolId, { aria: string; title: string; Icon: Icon; mono?: boolean }> = {
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
};

export function ComposerToolbar({ mac, onRun, onCodeBlock, emojiOpen, emojiRef }: {
  mac: boolean;
  onRun: (id: BarToolId) => void;
  onCodeBlock: (lang: string) => void;
  emojiOpen: boolean;
  emojiRef: RefObject<HTMLButtonElement | null>;
}) {
  const [toolAt, setToolAt] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const shown = TOOL_ORDER;
  // on a phone the bar scrolls sideways: the end with more tools beyond it fades out (channels.css `.ctools[data-more]`)
  const [more, setMore] = useState<ReturnType<typeof scrollEdges>>('none');
  const measure = useCallback((): void => {
    const el = bar.current;
    if (el) setMore(scrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth));
  }, []);
  useLayoutEffect(() => {
    measure();
    const el = bar.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, shown.length]);
  const slots: readonly string[] = shown;
  const at = Math.min(toolAt, Math.max(0, slots.length - 1));
  const tab = (key: string): { tabIndex: number; onFocus: () => void } => {
    const i = slots.indexOf(key);
    return { tabIndex: i === at ? 0 : -1, onFocus: () => setToolAt(i) };
  };

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

  const button = (id: BarToolId): ReactNode => {
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
        onClick={() => onRun(id)}
        {...tab(id)}
      >
        <Glyph />
      </button>
    );
  };

  return (
    <div className="ctools" role="toolbar" aria-label="Formatting" ref={bar} onKeyDown={onKey} onScroll={measure} data-testid="composer-tools" data-more={more === 'none' ? undefined : more}>
      {shown.map(button)}
    </div>
  );
}
