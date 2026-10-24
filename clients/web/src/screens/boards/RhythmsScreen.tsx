import { isAdmin, useSession } from '../../app/session';
import { useShell } from '../../shell/context';
import { useHeaderTopic } from '../../shell/topic';
import { RhythmsView } from './RhythmsView';

/*
 * Rhythms (SPEC §6.5, PLAN P6-08), a screen of its own with a sidebar entry: the timers that put work on the board without a person.
 * A lead or a workspace admin manages them; everyone else sees the schedule and the ledger.
 */
export function RhythmsScreen() {
  const { team, teamSlug } = useShell();
  const session = useSession();
  const slug = team?.slug ?? teamSlug ?? '';
  const canManage = isAdmin(session) || team?.myRole === 'lead';
  useHeaderTopic('Bot work on a schedule');

  return (
    <div className="bd-screen" data-testid="rhythms-screen">
      <header className="bd-head">
        <div>
          <h2 className="bd-title">Rhythms</h2>
          <p className="bd-sub">Bot work on a schedule: heartbeats, routines and cards that open themselves.</p>
        </div>
      </header>
      <RhythmsView slug={slug} canManage={canManage} />
    </div>
  );
}
