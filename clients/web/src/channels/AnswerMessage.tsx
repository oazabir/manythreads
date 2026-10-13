import { useMemo } from 'react';
import type { AnswerPayloadView } from '@manythreads/shared';
import { useShell } from '../shell/context';
import { Answer, type TeamSlugOf } from './Answer';
import { AnswerActions, type AnswerTools } from './AnswerShare';

/**
 * The Answer inside the app: the team's slug for each team id comes from the shell. With `tools` (the answer is in the reader's own conversation,
 * and they are who it was for) the chips act and the answer can be shared, saved as a page and handed on (`AnswerActions`, P5-17); without them
 * it is drawn as it was posted, chips inert.
 */
export function AnswerMessage({ payload, teamSlug, messageId, tools }: { payload: AnswerPayloadView; teamSlug: string | null; messageId?: string; tools?: AnswerTools | undefined }) {
  const { teams } = useShell();
  const teamSlugOf = useMemo<TeamSlugOf>(() => {
    const slugs = new Map(teams.map((t) => [t.id as string, t.slug] as const));
    return (teamId) => slugs.get(teamId) ?? null;
  }, [teams]);
  if (!tools || !messageId) return <Answer payload={payload} teamSlug={teamSlug} teamSlugOf={teamSlugOf} />;
  return <AnswerActions payload={payload} teamSlug={teamSlug} teamSlugOf={teamSlugOf} messageId={messageId} tools={tools} />;
}
