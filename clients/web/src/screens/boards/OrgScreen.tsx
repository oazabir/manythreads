import { PageHeader } from '../../components/PageHeader';
import { useShell } from '../../shell/context';
import { OrgChart } from './OrgChart';

/*
 * The org chart (SPEC §6.5, PLAN P6-07), a screen of its own with a sidebar entry: the team's leads above its members, and the bots
 * beside them with the hands each one may tag. It reads the roster and the bot roster the board already uses.
 */
export function OrgScreen() {
  const { team, teamSlug } = useShell();
  const slug = team?.slug ?? teamSlug ?? '';

  return (
    <div className="bd-screen" data-testid="org-screen">
      <PageHeader title="Org chart" description="Who leads, who is on the team, and who each bot can pass work to" />
      <OrgChart slug={slug} />
    </div>
  );
}
