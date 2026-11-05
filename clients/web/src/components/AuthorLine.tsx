import type { ReactNode } from 'react';
import { clock, fullStamp } from '../channels/format';
import type { AuthorMark } from '../channels/authorMark';
import { PersonLink } from '../presence/ProfileCard';

/**
 * The line above a message: the author's name (a person's name opens the profile card), the sender mark, and the time (its tooltip has the full date).
 * On a message that continues the run above (P21-01) the name stays for screen readers and for finding the row, but is not drawn; `children` (the
 * "edited" mark, a short note after an action) still show. The avatar and the presence dot are drawn by the row's avatar, not here.
 */
export function AuthorLine({ name, person, mark, createdAt, continued = false, children }: {
  name: string;
  /** Set for a person who has a profile card. */
  person?: { personId: string; email?: string | undefined } | undefined;
  mark?: AuthorMark | null | undefined;
  createdAt: string;
  continued?: boolean;
  children?: ReactNode;
}) {
  if (continued) {
    return (
      <div className={`who run-who ${children ? 'has-note' : ''}`}>
        <b className="sr-only">{name}</b>
        {children}
      </div>
    );
  }
  return (
    <div className="who">
      <b>{person ? <PersonLink personId={person.personId} name={name} email={person.email} /> : name}</b>
      {mark ? <span className="wh-mark" title={mark.title}>{mark.label}</span> : null}
      <time dateTime={createdAt} title={fullStamp(createdAt)} data-vt-mask>{clock(createdAt)}</time>
      {children}
    </div>
  );
}
