import type { ReactNode, Ref } from 'react';
import { useOwnsPageTitle } from '../shell/topic';

/**
 * The one page header (P21-12): a single h1, an optional one-line description, and the page's actions (at most one primary button).
 * Every screen uses it; the shell band shows the trail and the bell, never a second title. `headingRef` and `tabIndex -1` let a screen
 * that moves focus to its heading keep doing so; `copyId` keeps the `data-copy` hook of the onboarding copy tests.
 */
export function PageHeader({ title, description, actions, compact, headingRef, copyId, testIds }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
  copyId?: string;
  /** test ids for the title and description, so a screen's existing specs keep their hooks */
  testIds?: { title?: string; description?: string };
}) {
  useOwnsPageTitle();
  return (
    <header className={compact ? 'ph compact' : 'ph'} data-landmark="page-header">
      <div className="ph-text">
        <h1 className="ph-title" data-landmark="title" data-copy={copyId} data-testid={testIds?.title} tabIndex={-1} ref={headingRef}>{title}</h1>
        {description ? <p className="ph-desc" data-testid={testIds?.description}>{description}</p> : null}
      </div>
      {actions ? <div className="ph-actions">{actions}</div> : null}
    </header>
  );
}
