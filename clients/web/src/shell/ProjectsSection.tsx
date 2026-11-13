import { useEffect } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import type { NavContribution } from '@manythreads/shared';
import { useQuery } from '../app/useQuery';
import { useSession } from '../app/session';
import { fetchProjects } from '../screens/projects/api';
import { PROVIDER_NAME } from '../screens/projects/commands';
import { onProjectsChanged } from '../screens/projects/changed';
import { FoldButton } from './FoldButton';
import { navHref } from './nav';
import { useFold } from './sectionFold';

/** Past this many projects the section starts folded (until the person opens it on purpose). */
export const PROJECTS_FOLD_AT = 5;

/**
 * The "Projects" section of the sidebar: the heading opens the team's Projects page (add, edit, bot account, commit signing), and under it one row per
 * project of the team: the row opens that project (`/t/:team/projects/:projectId`), with a small tag for the provider it lives on (GitHub or GitLab).
 * The empty state is shown only while the team really has none; a server without the projects plugin answers 404 and the section then says the same.
 */
export function ProjectsSection({ item, slug }: { item: NavContribution; slug: string }) {
  const session = useSession();
  const path = useLocation().pathname;
  const q = useQuery(`sidebar-projects:${slug}`, () => fetchProjects(slug));
  const { reload } = q;
  useEffect(() => onProjectsChanged(reload), [reload]);
  const projects = q.status === 'ok' ? q.data.items : [];
  const [folded, toggleFolded] = useFold(session.person.id, slug, 'projects', projects.length > PROJECTS_FOLD_AT);
  const href = navHref(item, slug);
  const empty = q.status !== 'loading' && projects.length === 0;
  const heading = (
    <>
      <span>{item.label}</span>
      {empty && item.emptyState ? <span className="hint">{item.emptyState}</span> : null}
    </>
  );
  return (
    <>
      <div className="sec-row">
        {projects.length > 0 ? <FoldButton folded={folded} label={item.label} onToggle={toggleFolded} /> : null}
        {href ? <Link className="sec sec-link" to={href}>{heading}</Link> : <div className="sec">{heading}</div>}
      </div>
      {projects.length > 0 ? (
        <div className="bot-list" data-slot="projects">
          {projects.filter((p) => !folded || path.endsWith(`/projects/${p.id}`)).map((p) => (
            <NavLink
              key={p.id}
              to={`/t/${slug}/projects/${p.id}`}
              className={({ isActive }) => `it ${isActive ? 'on' : ''}`}
              data-testid="sidebar-project"
              data-project={p.name}
            >
              <span className="it-label">{p.name}</span>
              <span className="hint" data-testid="sidebar-project-provider">{PROVIDER_NAME[p.provider]}</span>
            </NavLink>
          ))}
        </div>
      ) : null}
    </>
  );
}
