import { Link } from 'react-router';

export type SpaceChoice = 'personal' | 'teams';

/**
 * The switch at the top of Memory and Knowledge: Personal (what only you can see) or Teams (what a team shares). Both ends are links, so the address says which side is
 * open and the back button works. A guest has no Personal side, so the screens do not draw the switch for a guest at all.
 */
export function SpaceSwitch({ space, personalHref, teamsHref, teamsLabel, label }: { space: SpaceChoice; personalHref: string; teamsHref: string | null; teamsLabel?: string; label: string }) {
  return (
    <div className="sp-switch" role="group" aria-label={label} data-testid="space-switch" data-space={space}>
      <Link to={personalHref} className={`sp-opt ${space === 'personal' ? 'on' : ''}`} aria-current={space === 'personal' ? 'page' : undefined} data-testid="space-personal">Personal</Link>
      {teamsHref ? (
        <Link to={teamsHref} className={`sp-opt ${space === 'teams' ? 'on' : ''}`} aria-current={space === 'teams' ? 'page' : undefined} data-testid="space-teams">{teamsLabel ?? 'Teams'}</Link>
      ) : (
        <span className="sp-opt off" aria-disabled="true" data-testid="space-teams">Teams</span>
      )}
    </div>
  );
}
