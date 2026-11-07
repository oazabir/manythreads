import { useEffect, useRef, useState, type RefObject } from 'react';
import { CHAT_TITLE_MAX, type ConversationListItem } from '@manythreads/shared';
import { ago } from '../../channels/format';
import { useMenuKeys } from '../../shell/RowMenu';
import { AddIcon, CloseIcon, ExportChatIcon, MoreIcon, PencilIcon, PinChatIcon, SearchIcon, TrashIcon, UnpinChatIcon } from '../../shell/icons';
import { useDismiss } from '../../shell/useDismiss';
import { railTitle, type RailGroup } from './model';

export type RailActions = {
  onOpen: (root: string) => void;
  onRename: (root: string, title: string) => void;
  onPin: (root: string, pinned: boolean) => void;
  onExport: (root: string) => void;
  onDelete: (root: string) => void;
};

function RailRow({ item, on, renaming, setRenaming, actions }: { item: ConversationListItem; on: boolean; renaming: boolean; setRenaming: (v: boolean) => void; actions: RailActions }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = (): void => {
    if (panel.current?.contains(document.activeElement)) button.current?.focus();
    setOpen(false);
  };
  useDismiss(open, close, box);
  const keys = useMenuKeys(open, panel, close);
  const [draft, setDraft] = useState(railTitle(item));
  useEffect(() => {
    if (renaming) setDraft(railTitle(item));
  }, [renaming, item]);
  const unread = item.unreadCount > 0;
  const save = (): void => {
    const title = draft.trim();
    setRenaming(false);
    if (title !== '' && title !== railTitle(item)) actions.onRename(item.threadRootId, title);
  };
  return (
    <li role="option" aria-selected={on} className={`ch-row ${on ? 'on' : ''} ${unread ? 'unread' : ''}`} data-testid="chat-row" data-root-id={item.threadRootId} data-pinned={item.pinned ? 'true' : 'false'}>
      {renaming ? (
        <input
          className="ch-rename"
          value={draft}
          maxLength={CHAT_TITLE_MAX}
          aria-label="Name of the chat"
          data-testid="chat-rename-input"
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setRenaming(false);
            }
          }}
        />
      ) : (
        <button type="button" className="ch-row-main" onClick={() => actions.onOpen(item.threadRootId)} data-testid="chat-row-open">
          <span className="ch-row-title">{railTitle(item)}</span>
          <span className="ch-row-meta" data-vt-mask>{ago(item.lastActivityAt)}</span>
          {unread ? <span className="ch-dot" role="img" aria-label="Unread" data-testid="chat-row-unread" /> : null}
        </button>
      )}
      <div className="ch-row-menu" ref={box}>
        <button ref={button} type="button" className="ch-row-more" aria-label={`Options for ${railTitle(item)}`} aria-haspopup="menu" aria-expanded={open} data-testid="chat-row-menu" onClick={() => setOpen((o) => !o)}>
          <MoreIcon />
        </button>
        {open ? (
          <div className="ch-menu" role="menu" aria-label={`Options for ${railTitle(item)}`} ref={panel as RefObject<HTMLDivElement>} onKeyDown={keys}>
            <button type="button" role="menuitem" className="ch-menu-item" data-testid="chat-menu-rename" onClick={() => { close(); setRenaming(true); }}><PencilIcon /> Rename</button>
            <button type="button" role="menuitem" className="ch-menu-item" data-testid="chat-menu-pin" onClick={() => { close(); actions.onPin(item.threadRootId, !item.pinned); }}>
              {item.pinned ? <UnpinChatIcon /> : <PinChatIcon />} {item.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button type="button" role="menuitem" className="ch-menu-item" data-testid="chat-menu-export" onClick={() => { close(); actions.onExport(item.threadRootId); }}><ExportChatIcon /> Export as Markdown</button>
            <button type="button" role="menuitem" className="ch-menu-item danger" data-testid="chat-menu-delete" onClick={() => { close(); actions.onDelete(item.threadRootId); }}><TrashIcon /> Delete</button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The history of the person's chats with this bot, grouped by day with the pinned ones first. A search box above it (Ctrl or Cmd+K), a New chat button
 * (Ctrl or Cmd+Shift+O). On a phone it is a drawer that slides over the chat and closes when a chat is picked.
 */
export function HistoryRail({ groups, selected, query, onQuery, status, onRetry, more, loadingMore, onMore, onNew, drawer, onClose, searchRef, actions }: {
  groups: readonly RailGroup[];
  selected: string | null;
  query: string;
  onQuery: (q: string) => void;
  status: 'loading' | 'ok' | 'error';
  onRetry: () => void;
  more: boolean;
  loadingMore: boolean;
  onMore: () => void;
  onNew: () => void;
  /** Phone: the rail is a drawer; `null` on a wide screen, else whether it is open. */
  drawer: boolean | null;
  onClose: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  actions: RailActions;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const empty = groups.length === 0;
  const searching = query.trim() !== '';
  return (
    <aside
      className={`ch-rail ${drawer === null ? '' : 'drawer'} ${drawer === true ? 'open' : ''}`}
      aria-label="Chat history"
      data-landmark="chat-history"
      data-testid="chat-rail"
      {...(drawer === false ? { inert: true } : {})}
    >
      <div className="ch-rail-head">
        <button type="button" className="btn primary ch-new" onClick={onNew} data-testid="chat-new" title="New chat (Ctrl+Shift+O)">
          <AddIcon /> <span>New chat</span>
        </button>
        {drawer !== null ? <button type="button" className="icon-btn" aria-label="Close the history" onClick={onClose} data-testid="chat-rail-close"><CloseIcon /></button> : null}
      </div>
      <div className="ch-search">
        <SearchIcon />
        <input
          ref={searchRef}
          type="search"
          className="ch-search-input"
          value={query}
          placeholder="Search your chats"
          aria-label="Search your chats"
          data-testid="chat-search"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query !== '') {
              e.preventDefault();
              e.stopPropagation();
              onQuery('');
            }
          }}
        />
      </div>
      <div className="ch-rail-list" data-testid="chat-history">
        {status === 'loading' && empty ? <p className="ch-note" aria-busy="true">Loading…</p> : null}
        {status === 'error' ? (
          <div className="ch-note" role="alert">
            <p>Could not load your chats.</p>
            <button type="button" className="btn s" onClick={onRetry}>Try again</button>
          </div>
        ) : null}
        {status === 'ok' && empty ? <p className="ch-note" data-testid="chat-history-empty">{searching ? 'No chat matches that.' : 'Your chats show here.'}</p> : null}
        {groups.map((g) => (
          <section key={g.id} className="ch-group" aria-label={g.label} data-testid={`chat-group-${g.id}`}>
            <h3 className="ch-group-title">{g.label}</h3>
            <ul className="ch-rows" role="listbox" aria-label={g.label}>
              {g.items.map((item) => (
                <RailRow key={item.threadRootId} item={item} on={item.threadRootId === selected} renaming={renaming === item.threadRootId} setRenaming={(v) => setRenaming(v ? item.threadRootId : null)} actions={actions} />
              ))}
            </ul>
          </section>
        ))}
        {more ? (
          <button type="button" className="btn s ch-more" disabled={loadingMore} aria-busy={loadingMore} onClick={onMore} data-testid="chat-older">{loadingMore ? 'Loading…' : 'Show older'}</button>
        ) : null}
      </div>
    </aside>
  );
}
