import { useShell } from '../../shell/context';
import { useHeaderTopic } from '../../shell/topic';
import { OrgChart } from './OrgChart';

/*
 * The org chart (SPEC §6.5, PLAN P6-07), a screen of its own with a sidebar entry: the team's leads above its members, and the bots
 * beside them with the hands each one may tag. It reads the roster and the bot roster the board already uses.
 */
export function OrgScreen() {
  const { team, teamSlug } = useShell();
  const slug = team?.slug ?? teamSlug ?? '';
  useHeaderTopic('Leads, members and the hands a bot may tag');

  return (
    <div className="bd-screen" data-testid="org-screen">
      <header className="bd-head">
        <div>
          <h2 className="bd-title">Org chart</h2>
          <p className="bd-sub">Who is on the team, and which hands a bot may hand work to.</p>
        </div>
      </header>
      <OrgChart slug={slug} />
    </div>
  );
}
