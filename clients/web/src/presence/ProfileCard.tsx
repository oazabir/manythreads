import { useState, type ReactNode } from 'react';
import { Avatar } from '../components/ui';
import { Dialog } from '../components/Dialog';
import { usePeople } from '../channels/hooks';
import { useSession } from '../app/session';
import { useCanShowPresence, useNow, usePresence, usePresenceCard } from './hooks';
import { MyAvatarPicker } from '../avatars/MyAvatarPicker';
import { PresenceDot } from './PresenceDot';
import { deviceTimeZone } from './settingsModel';
import { profileFacts } from './profileModel';

/** One labelled line of the card. */
function Fact({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="pcard-fact" data-testid={testId}>
      <dt className="pcard-k">{label}</dt>
      <dd className="pcard-v">{children}</dd>
    </div>
  );
}

/**
 * A person's profile card (PLAN P14-01): whether they are active, their status, local time with how it compares with the reader's, working hours and,
 * while they are away, when they are back and who to ask. It shows only what the presence plugin served for this reader; a person who shared nothing gets
 * the name and the word Offline.
 */
export function ProfileCard({ personId, name, email, onClose }: { personId: string; name: string; email?: string | undefined; onClose: () => void }) {
  const people = usePeople();
  const session = useSession();
  const card = usePresenceCard(personId);
  const { me } = usePresence();
  const now = useNow(30_000);
  const known = people.byPerson(personId);
  const mine = personId === session.person.id;
  const [picking, setPicking] = useState(false);
  const facts = profileFacts(card, now, me?.timeZone ?? deviceTimeZone());
  const mail = email ?? known?.email;
  const live = useCanShowPresence(personId);
  // the delegate is named when the reader's team list has them; a delegate the reader cannot name is still "a colleague", not nothing
  const delegateId = facts.outOfOffice?.delegatePersonId ?? null;
  const delegate = delegateId ? (people.byPerson(delegateId)?.name ?? 'a colleague') : null;
  return (
    <Dialog title={name} onClose={onClose} testId="profile-card" footer={<button type="button" className="btn" onClick={onClose} data-autofocus>Close</button>}>
      <div className="pcard">
        <div className="pcard-head">
          <Avatar name={name} avatar={mine ? session.person.avatar : known?.avatar} personId={personId} />
          <div className="pcard-id">
            <p className="pcard-presence" data-testid="profile-presence">
              <PresenceDot personId={personId} />
              {live ? <span>{facts.presence}</span> : null}
              {personId === session.person.id ? <span className="pcard-you"> (you)</span> : null}
            </p>
            {mail ? <p className="pcard-line" data-vt-mask>{mail}</p> : null}
            {known ? <p className="pcard-line">{known.role === 'lead' ? 'Team lead' : 'Member'}</p> : null}
            {mine ? <button type="button" className="linkish pcard-pic" onClick={() => setPicking(true)} data-testid="profile-change-picture">Change picture</button> : null}
          </div>
        </div>
        <dl className="pcard-facts">
          {facts.status ? <Fact label="Status" testId="profile-status">{facts.status}</Fact> : null}
          {facts.outOfOffice ? (
            <Fact label="Out of office" testId="profile-ooo">
              <span className="pcard-ooo">
                {facts.outOfOffice.returns ?? 'No return day set'}
                {facts.outOfOffice.message ? <span className="pcard-sub">{facts.outOfOffice.message}</span> : null}
                {delegate ? <span className="pcard-sub">{delegate === 'a colleague' ? 'Ask a colleague meanwhile' : `Ask ${delegate} meanwhile`}</span> : null}
              </span>
            </Fact>
          ) : null}
          {facts.localTime ? (
            <Fact label="Local time" testId="profile-time">
              <span data-vt-mask>{facts.localTime.clock}</span>
              <span className="pcard-sub">{[facts.localTime.zone, facts.localTime.offset].filter(Boolean).join(' · ')}</span>
            </Fact>
          ) : null}
          {facts.workingHours ? (
            <Fact label="Working hours" testId="profile-hours">
              {facts.workingHours}
              {facts.inHours !== null ? <span className="pcard-sub">{facts.inHours ? 'Working hours now' : 'Outside working hours now'}</span> : null}
            </Fact>
          ) : null}
        </dl>
        {live && !facts.status && !facts.outOfOffice && !facts.localTime && !facts.workingHours ? <p className="pcard-empty" data-testid="profile-empty">{name} has not shared a status, time zone or working hours.</p> : null}
      </div>
    {picking ? <MyAvatarPicker onClose={() => setPicking(false)} /> : null}
    </Dialog>
  );
}

/**
 * A name (or an avatar) that opens the person's profile card when pressed. It is only text where no presence is shown (no plugin on the server, cards not
 * here yet, or a guest looking at somebody else), so nothing opens onto an empty card. `decorative` is for an avatar beside a name that is already a
 * button: a plain wrapper that takes a click, with no role and no tab stop, and nothing focusable under `aria-hidden`; the name beside it is the control.
 * The card is a sibling of the control, not a child, so a click inside the card never reaches the control.
 */
export function PersonLink({ personId, name, email, decorative = false, children }: { personId: string | null | undefined; name: string; email?: string | undefined; decorative?: boolean; children?: ReactNode }) {
  const show = useCanShowPresence(personId);
  const [open, setOpen] = useState(false);
  if (!show || !personId) return <>{children ?? name}</>;
  return (
    <>
      {decorative ? (
        <span className="pcard-avatar" onClick={() => setOpen(true)}>{children}</span>
      ) : (
        <button type="button" className="pcard-open" aria-haspopup="dialog" title={`${name}'s profile`} onClick={() => setOpen(true)} data-testid="profile-open">
          {children ?? name}
        </button>
      )}
      {open ? <ProfileCard personId={personId} name={name} email={email} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
