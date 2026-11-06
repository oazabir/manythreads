import type { Approval } from '@manythreads/shared';
import { waitAge } from './state';

/** How long a pending request has waited. Neutral at first; amber with the same words once it is more than a day old (the words carry the meaning, not the colour). */
export function AgePill({ approval }: { approval: Pick<Approval, 'createdAt'> }) {
  const age = waitAge(approval.createdAt);
  return (
    <span className={`apr-age ${age.overdue ? 'overdue' : ''}`} data-testid="approval-age" data-overdue={age.overdue ? 'true' : 'false'} data-vt-mask title={age.overdue ? 'This has waited more than a day.' : undefined}>
      {age.label}
    </span>
  );
}
