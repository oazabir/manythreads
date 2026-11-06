import { Navigate, useLocation } from 'react-router';

/** Which Account page holds a section that old links name by its anchor (`/account#status-and-dnd`, the digest email's `/account#acc-notifications`). */
export function accountPageFor(hash: string): 'profile' | 'notifications' | 'connections' | 'security' {
  const id = hash.replace(/^#/, '');
  if (id === 'status-and-dnd' || id === 'acc-presence' || id === 'acc-notifications') return 'notifications';
  if (id === 'acc-connections') return 'connections';
  if (id === 'acc-password' || id === 'acc-sessions' || id === 'acc-methods') return 'security';
  return 'profile';
}

/** `/account` opens Profile, or the page that now holds the section the link points at; the anchor is kept. */
export function AccountIndex() {
  const { hash } = useLocation();
  return <Navigate to={{ pathname: `/account/${accountPageFor(hash)}`, hash }} replace />;
}
