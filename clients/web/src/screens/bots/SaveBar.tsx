import { useRef, useState } from 'react';
import { CaretIcon } from '../../shell/icons';
import { useMenuKeys } from '../../shell/RowMenu';
import { useDismiss } from '../../shell/useDismiss';
import type { DraftIssue } from './store';

/** What the bar says about a draft the schema refuses: the first problem, and how many more there are. */
export function issueLine(issues: ReadonlyArray<DraftIssue>): string | null {
  const first = issues[0];
  if (!first) return null;
  return `Cannot save yet: ${first.path ? `${first.path}: ` : ''}${first.message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`;
}

/** The bar is drawn only while something changed or the draft has a problem to show. */
export const showSaveBar = (s: { dirty: boolean; issues: ReadonlyArray<unknown> }): boolean => s.dirty || s.issues.length > 0;

/**
 * The bot page's save bar (P21-17): sticks to the bottom of the page and appears only when the draft changed. One primary Save (it commits the
 * change and keeps it on record as a proposal); the arrow beside it holds "Save as proposal" and "Discard changes". Focus never moves into the
 * bar by itself.
 */
export function SaveBar({ busy, issues, onSave, onDiscard }: { busy: boolean; issues: ReadonlyArray<DraftIssue>; onSave: (applyNow: boolean) => void; onDiscard: () => void }) {
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
  const blocked = issues.length > 0;
  const problem = issueLine(issues);
  return (
    <section className="b-savebar" role="region" aria-label="Unsaved changes" data-testid="bot-foot">
      <div className="b-savebar-msg">
        <span className="b-savebar-state" aria-live="polite" data-testid="dirty-state">{busy ? 'Saving…' : 'Unsaved changes'}</span>
        {problem ? <span className="b-warnline" role="alert" data-testid="draft-issues">{problem}</span> : null}
      </div>
      <div className="b-savebar-act" ref={box}>
        <div className="b-split">
          <button type="button" className="btn primary b-split-main" data-testid="save-bot" disabled={busy || blocked} onClick={() => onSave(true)}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            ref={button}
            className="btn primary b-split-arrow"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="More ways to save"
            title="More ways to save"
            data-testid="save-more"
            disabled={busy}
            onClick={() => setOpen((o) => !o)}
          >
            <CaretIcon open />
          </button>
        </div>
        {open ? (
          <div className="menu menu-up b-savebar-pop" role="menu" aria-label="More ways to save" ref={panel} onKeyDown={keys}>
            <button type="button" role="menuitem" className="menu-item" data-testid="propose-bot" disabled={blocked} onClick={() => { close(); onSave(false); }}>
              Save as proposal
            </button>
            <button type="button" role="menuitem" className="menu-item" data-testid="reset-bot" onClick={() => { close(); onDiscard(); }}>
              Discard changes
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
