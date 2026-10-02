import { Outlet } from 'react-router';
import { isAdmin, useSession } from '../app/session';
import { NotFoundBody } from '../components/states';

/** Workspace settings are admin-only; everyone else gets 404 (the page does not exist for them). */
export function AdminOnly() {
  const session = useSession();
  if (!isAdmin(session)) return <div className="inline-state"><NotFoundBody /></div>;
  return <Outlet />;
}
