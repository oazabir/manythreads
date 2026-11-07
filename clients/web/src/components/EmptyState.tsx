import type { ReactNode } from 'react';
import { Link } from 'react-router';

/*
 * The one empty state (P21-22): a large outline icon, a title, one line of help and at most one action. It reuses the global `.empty`
 * dashed box from screens.css and adds `.es` (styles/states.css). The icon is a ProIcon from shell/icons.tsx; it is drawn at 48 px with a
 * thin stroke. The action is a link (`to`) or a button (`onClick`), never both, and there is only one: the thing to do next.
 */
export type EmptyStateIcon = (props: { size?: number; strokeWidth?: number; className?: string }) => ReactNode;

export interface EmptyStateAction {
  label: string;
  to?: string;
  onClick?: () => void;
}

export function EmptyState({ icon: Icon, title, children, action, testId }: {
  icon: EmptyStateIcon;
  title: string;
  children?: ReactNode;
  action?: EmptyStateAction;
  testId?: string;
}) {
  return (
    <div className="empty es" data-testid={testId}>
      <span className="es-icon"><Icon size={48} strokeWidth={1.25} /></span>
      <p className="empty-title es-title">{title}</p>
      {children ? <div className="empty-body es-body">{children}</div> : null}
      {action?.to ? (
        <Link className="btn primary es-action" to={action.to}>{action.label}</Link>
      ) : action ? (
        <button type="button" className="btn primary es-action" onClick={action.onClick}>{action.label}</button>
      ) : null}
    </div>
  );
}
