import { useSession, useSessionState } from '../app/session';
import { AvatarPicker } from './AvatarPicker';

/** The signed-in person's own picture dialog: a choice is kept in the session at once, so every avatar of theirs on screen changes with it. */
export function MyAvatarPicker({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const { setSession } = useSessionState();
  return (
    <AvatarPicker
      name={session.person.name}
      target={{ kind: 'person', personId: session.person.id }}
      current={session.person.avatar}
      onChanged={(avatar) => setSession({ ...session, person: { ...session.person, avatar } })}
      onClose={onClose}
    />
  );
}
