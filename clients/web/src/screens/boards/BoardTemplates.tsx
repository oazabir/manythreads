import type { ReactNode } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { BoardsIcon } from '../../shell/icons';
import { TemplateContentIcon, TemplateDeliveryIcon, TemplateSupportQueueIcon } from './icons';
import { BOARD_TEMPLATES, type BoardTemplate, type BoardTemplateId } from './templates';

/*
 * The empty Boards page (PLAN P21-15): three boards to start from, each with a picture, one line, its columns and one button. A team lead or a
 * workspace admin makes the first board; anyone else sees the same page without the button, and a line that says who can. The blank board
 * (a name and the five usual columns) stays below the cards, so nothing the page could do before is gone.
 */

const ICONS: Record<BoardTemplateId, typeof TemplateDeliveryIcon> = {
  delivery: TemplateDeliveryIcon,
  support: TemplateSupportQueueIcon,
  content: TemplateContentIcon,
};

export function BoardTemplates({ canManage, busy, onStart, children }: {
  canManage: boolean;
  /** The id of the template being created, so its button shows it and the others wait. */
  busy: BoardTemplateId | null;
  onStart: (template: BoardTemplate) => void;
  /** Under the cards: the blank-board form and a refusal, if there is one. */
  children?: ReactNode;
}) {
  if (!canManage) {
    return (
      <div data-testid="boards-empty">
        <EmptyState icon={BoardsIcon} title="No boards yet">
          A board is a saved view over the team&apos;s cards. A team lead or a workspace admin creates the first one.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="bd-start" data-testid="boards-empty">
      <h2 className="bd-start-title">Start your first board</h2>
      <p className="bd-start-body">A board is a saved view over the team&apos;s cards. Pick a layout; you can rename, add and move its columns afterwards.</p>
      <div className="bd-tiles" data-landmark="board-templates">
        {BOARD_TEMPLATES.map((t) => {
          const Icon = ICONS[t.id];
          return (
            <section key={t.id} className="bd-tile" data-testid="board-template" data-template={t.id} aria-label={t.name}>
              <span className="bd-tile-pic"><Icon /></span>
              <h3 className="bd-tile-title">{t.name}</h3>
              <p className="bd-tile-line">{t.line}</p>
              <p className="bd-tile-cols">{t.columns.map((c) => c.name).join(' · ')}</p>
              <button type="button" className="btn primary bd-tile-act" disabled={busy !== null} aria-label={`Start from this template: ${t.name}`} onClick={() => onStart(t)} data-testid="board-template-start">
                {busy === t.id ? 'Creating…' : 'Start from this template'}
              </button>
            </section>
          );
        })}
      </div>
      {children}
    </div>
  );
}
