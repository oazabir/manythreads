import { useMemo, type ReactNode } from 'react';
import { AnswerPayloadView, platformOnlyMessage } from '@manythreads/shared';
import { Answer, type TeamSlugOf } from '../channels/Answer';
import { SurfaceHostContext, useSurfaceHost, type SurfaceHost } from './host';
import type { SurfaceView } from './views';

// The Answer as a registered part (PLAN P9-07). There is ONE drawing of an Answer: `Answer` in ../channels/Answer.tsx. This file is the registered way
// in: the `Answer` view of the surface registry reads its props through the same schema the answer plugin stores (`AnswerPayloadView`, which also
// tolerates a citation kind a newer server wrote), asks the page what it needs (`SurfaceHost.answer`) and draws it. A message in a channel thread and a
// message in a conversation both go through `AnswerSurface`, so a stored answer looks the same wherever it is read; only what the page lends differs
// (the conversation lends chips that act, a thread lends none).

/** The registered view. Only a page that lends `answer` (the app's own messages) gets a card; in a bot's screen it is the "not available" card. */
export const answerView: SurfaceView = ({ props }) => <AnswerPart props={props} />;

function AnswerPart({ props }: { props: Record<string, unknown> }): ReactNode {
  const lent = useSurfaceHost().answer;
  // The Answer says whom a reply was for and what it rests on, so only the platform may draw one: a bot's screen (a page that lends no `answer`) gets the same
  // "not available" card as a part this app cannot draw. (The card is written out here, not imported from ./Surface, which would make the modules a loop.)
  if (!lent) {
    return (
      <div className="sf-reject" role="note" data-testid="surface-rejection" data-code="unknown_component">
        <div className="sf-reject-title">This part is not available</div>
        <div className="sf-reject-why">{platformOnlyMessage('Answer')}</div>
        <div className="sf-reject-name">Answer</div>
      </div>
    );
  }
  const payload = AnswerPayloadView.parse(props);
  return <Answer payload={payload} teamSlug={lent.teamSlug} {...(lent.teamSlugOf ? { teamSlugOf: lent.teamSlugOf } : {})} {...(lent.onChip ? { onChip: lent.onChip } : {})} />;
}

/** Draws a stored answer through the registered view. This is what the app's messages use. */
export function AnswerSurface({
  payload,
  teamSlug,
  teamSlugOf,
  onChip,
}: {
  payload: AnswerPayloadView;
  teamSlug: string | null;
  teamSlugOf?: TeamSlugOf | undefined;
  onChip?: NonNullable<SurfaceHost['answer']>['onChip'];
}): ReactNode {
  const host = useMemo<SurfaceHost>(
    () => ({ answer: { teamSlug, ...(teamSlugOf ? { teamSlugOf } : {}), ...(onChip ? { onChip } : {}) } }),
    [teamSlug, teamSlugOf, onChip],
  );
  return <SurfaceHostContext.Provider value={host}>{answerView({ props: payload, children: null, nodeId: 'answer' })}</SurfaceHostContext.Provider>;
}
