import type { WorkshopEntry, WorkshopMode, WorkshopSessionSummary } from '@manythreads/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert } from '../../components/ui';
import { MODES, OUTCOME_WORDS, PROPOSAL_ROLE_WORDS, charsLeft, modeInfo, nextTab, textReady, type View } from './model';

/*
 * The pieces of the Workshop tab (PLAN P7-05). Every class is prefixed `ws-`. A row of tabs follows the usual keyboard pattern: the chosen tab is the one stop in the Tab order, the arrow
 * keys move between tabs, and Home and End jump to the ends.
 */

type TabItem<T extends string> = { id: T; label: string; /** Why this tab cannot be chosen by this person; it stays on the row but chooses nothing. */ disabledReason?: string };

export function TabRow<T extends string>({ label, items, value, onChange, panelId, testPrefix, className, idPrefix, focusChosen = false }: {
  label: string;
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  /** The panel the chosen tab controls. Only the chosen tab names it: the others' panels are not on the page. */
  panelId?: string;
  testPrefix: string;
  className?: string;
  /** A fixed start for the tabs' ids, so a panel can name the tab that labels it. */
  idPrefix?: string;
  /** Put focus on the chosen tab when the row appears (the row was replaced by the one on the other side after a switch). */
  focusChosen?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const generated = useId();
  const idBase = idPrefix ?? generated;
  useEffect(() => {
    if (focusChosen) refs.current[items.findIndex((t) => t.id === value)]?.focus();
    // once, when the row appears
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const to = nextTab(e.key, index, items.length);
    if (to === null) return;
    e.preventDefault();
    const item = items[to];
    if (!item) return;
    // a tab that cannot be chosen can still be reached (its reason is read out), but it does not become the chosen one
    if (item.disabledReason === undefined) onChange(item.id);
    refs.current[to]?.focus();
  };
  return (
    <>
    <div className={`ws-tabs ${className ?? ''}`} role="tablist" aria-label={label}>
      {items.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idBase}-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={value === t.id ? panelId : undefined}
          aria-disabled={t.disabledReason !== undefined ? true : undefined}
          aria-describedby={t.disabledReason !== undefined ? `${idBase}-${t.id}-why` : undefined}
          tabIndex={value === t.id ? 0 : -1}
          className={`ws-tab ${value === t.id ? 'on' : ''}`}
          data-testid={`${testPrefix}-${t.id}`}
          onClick={() => { if (t.disabledReason === undefined) onChange(t.id); }}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
    {/* why a tab cannot be chosen, in plain words and in sight (the tab points at it with aria-describedby); outside the tab list, which holds tabs only */}
    {items.map((t) => (t.disabledReason !== undefined ? <p key={t.id} id={`${idBase}-${t.id}-why`} className="ws-hint" data-testid={`${testPrefix}-${t.id}-why`}>{t.disabledReason}</p> : null))}
    </>
  );
}

const VIEWS: ReadonlyArray<TabItem<View>> = [
  { id: 'chat', label: 'Chat' },
  { id: 'workshop', label: 'Workshop' },
];

/** The panel of whichever side of the bot's page is showing, and the tab that labels it (`role="tabpanel"` goes on the page's own root, which holds the tab row). */
export const VIEW_PANEL_ID = 'ws-view-panel';
export const viewTabId = (view: View): string => `ws-view-tab-${view}`;
export const viewPanelProps = (view: View): { id: string; role: 'tabpanel'; 'aria-labelledby': string } => ({ id: VIEW_PANEL_ID, role: 'tabpanel', 'aria-labelledby': viewTabId(view) });

// Chat and Workshop are two screens, each with its own copy of the row: choosing the other side removes the row that has focus and puts a new one in its place. The new row takes focus,
// so a person at the keyboard stays on the tab they chose. The mark is cleared a moment later in case the choice did not change the screen after all.
let refocusViews = false;

/** Chat | Workshop, shown on both sides of a bot's conversation page. */
export function ViewTabs({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const [focusChosen] = useState(() => {
    const was = refocusViews;
    refocusViews = false;
    return was;
  });
  return (
    <TabRow
      label="Chat or Workshop"
      items={VIEWS}
      value={view}
      onChange={(v) => {
        refocusViews = true;
        window.setTimeout(() => {
          refocusViews = false;
        }, 1500);
        onChange(v);
      }}
      panelId={VIEW_PANEL_ID}
      idPrefix="ws-view-tab"
      focusChosen={focusChosen}
      testPrefix="ws-view"
      className="ws-views"
    />
  );
}

export function ModeTabs({ mode, onChange, panelId, rehearseReason }: { mode: WorkshopMode; onChange: (m: WorkshopMode) => void; panelId: string; rehearseReason?: string | undefined }) {
  const items = MODES.map((m) => (m.id === 'rehearse' && rehearseReason !== undefined ? { id: m.id, label: m.label, disabledReason: rehearseReason } : { id: m.id, label: m.label }));
  return <TabRow label="Workshop mode" items={items} value={mode} onChange={onChange} panelId={panelId} testPrefix="ws-mode" className="ws-modes" />;
}

const STATUS_WORDS: Record<WorkshopSessionSummary['status'], string> = {
  working: 'working',
  ready: 'open',
  ended: 'ended',
  failed: 'stopped',
  cancelled: 'stopped',
};

export function EarlierList({ items, current, onOpen }: { items: ReadonlyArray<WorkshopSessionSummary>; current: string | null; onOpen: (id: string) => void }) {
  if (items.length === 0) return <p className="ws-hint" data-testid="ws-earlier-empty">No conversations in this mode yet.</p>;
  return (
    <ul className="ws-earlier" data-testid="ws-earlier">
      {items.map((s) => (
        <li key={s.id}>
          <button type="button" className={`ws-earlier-btn ${current === s.id ? 'on' : ''}`} aria-current={current === s.id ? 'true' : undefined} data-testid="ws-open" onClick={() => onOpen(s.id)}>
            <span className="ws-earlier-title" data-vt-mask>{s.title || 'Untitled'}</span>
            <span className="ws-earlier-meta">{STATUS_WORDS[s.status]} · {s.messageCount} {s.messageCount === 1 ? 'message' : 'messages'}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function EntryView({ entry, slug, onCorrect }: { entry: WorkshopEntry; slug: string; onCorrect?: (entryId: string, excerpt: string) => void }) {
  switch (entry.kind) {
    case 'person':
      return (
        <li className="ws-msg ws-person" data-testid="ws-person">
          <p className="ws-who">You</p>
          {entry.about ? <blockquote className="ws-about" data-vt-mask>About this reply: {entry.about.excerpt}</blockquote> : null}
          <p className="ws-text" data-vt-mask>{entry.text}</p>
        </li>
      );
    case 'reply':
      return (
        <li className={`ws-msg ws-reply ${entry.rehearsal ? 'ws-rehearsed' : ''}`} data-testid="ws-reply" data-rehearsal={entry.rehearsal ? 'true' : 'false'}>
          <p className="ws-who">
            {entry.rehearsal ? 'The bot, in a rehearsal' : 'The helper'}
            {entry.rehearsal ? <span className="ws-tag">a test answer, nothing was sent</span> : null}
          </p>
          <p className="ws-text" data-vt-mask>{entry.text}</p>
          {entry.rehearsal && onCorrect ? (
            <div className="ws-row">
              <button type="button" className="btn s" data-testid="ws-correct" onClick={() => onCorrect(entry.id, entry.text.slice(0, 300))}>Correct this reply</button>
            </div>
          ) : null}
        </li>
      );
    case 'step':
      return (
        <li className={`ws-step ws-${entry.outcome}`} data-testid="ws-step" data-outcome={entry.outcome}>
          <span className="ws-step-what" data-vt-mask>{entry.what}</span>
          <span className="ws-step-out">{OUTCOME_WORDS[entry.outcome]}</span>
          {entry.badge ? <span className="ws-badge" data-testid="ws-badge">{entry.badge}</span> : null}
        </li>
      );
    case 'proposal':
      return (
        <li className="ws-msg ws-proposal" data-testid="ws-proposal" data-role={entry.role}>
          <p className="ws-who">{PROPOSAL_ROLE_WORDS[entry.role]}</p>
          <p className="ws-text" data-vt-mask>{entry.title}</p>
          <p className="ws-row">
            <span className="mono ws-path">{entry.path}</span>
            <Link className="btn s" to={`/t/${slug}/proposals/${entry.proposalId}`} data-testid="ws-proposal-link">Review the proposal</Link>
          </p>
        </li>
      );
    case 'refusal':
      return (
        <li className="ws-msg ws-refusal" data-testid="ws-refusal">
          <p className="ws-who">Not done</p>
          <p className="ws-text" data-vt-mask>{entry.text}</p>
        </li>
      );
    case 'notice':
      return (
        <li className="ws-notice" data-testid="ws-notice">
          <span data-vt-mask>{entry.text}</span>
        </li>
      );
  }
}

export function Transcript({ entries, slug, onCorrect, children }: { entries: ReadonlyArray<WorkshopEntry>; slug: string; onCorrect?: (entryId: string, excerpt: string) => void; children?: ReactNode }) {
  return (
    <ol className="ws-thread" data-testid="ws-thread">
      {entries.map((e) => (
        <EntryView key={e.id} entry={e} slug={slug} {...(onCorrect ? { onCorrect } : {})} />
      ))}
      {children}
    </ol>
  );
}

export function Compose({ mode, text, onText, onSend, busy, blocked, error, canRule, onRule, about, onDropAbout, ruleDisabled }: {
  mode: WorkshopMode;
  text: string;
  onText: (t: string) => void;
  onSend: () => void;
  busy: boolean;
  /** Why nothing can be sent now (the helper is answering, the conversation is over), or null. */
  blocked: string | null;
  error: string | null;
  canRule: boolean;
  onRule: () => void;
  about: string | null;
  onDropAbout: () => void;
  ruleDisabled: boolean;
}) {
  const id = useId();
  const info = modeInfo(mode);
  const ready = textReady(text) && !busy && blocked === null;
  const left = charsLeft(text);
  return (
    <form
      className="ws-compose"
      data-testid="ws-compose"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSend();
      }}
    >
      <label className="ws-label" htmlFor={`${id}-t`}>{mode === 'rehearse' ? 'Say something to the bot' : mode === 'live' ? 'Ask about its real work' : 'Tell the helper'}</label>
      {about ? (
        <p className="ws-about-chip" data-testid="ws-about-chip">
          <span data-vt-mask>Correcting: {about}</span>
          <button type="button" className="btn s" data-testid="ws-about-drop" onClick={onDropAbout}>Remove</button>
        </p>
      ) : null}
      <textarea
        id={`${id}-t`}
        className="ws-textarea"
        rows={3}
        maxLength={2000}
        value={text}
        placeholder={info.placeholder}
        aria-describedby={`${id}-h`}
        data-testid="ws-text"
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <p className="ws-hint" id={`${id}-h`}>
        {blocked ?? 'Press Ctrl+Enter to send.'} {left < 200 ? `${String(left)} characters left.` : ''}
      </p>
      {error ? <Alert>{error}</Alert> : null}
      <div className="ws-row">
        <button type="submit" className="btn primary" aria-disabled={!ready} data-testid="ws-send" onClick={(e) => { if (!ready) e.preventDefault(); }}>
          {busy ? 'Sending…' : 'Send'}
        </button>
        {canRule ? (
          <button type="button" className="btn" aria-disabled={ruleDisabled || !ready} data-testid="ws-rule" onClick={() => { if (!ruleDisabled && ready) onRule(); }}>
            Make that a rule
          </button>
        ) : null}
      </div>
    </form>
  );
}
