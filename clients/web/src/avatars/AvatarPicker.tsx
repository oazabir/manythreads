import { useRef, useState } from 'react';
import { OFFERED_AVATAR_PRESETS, avatarLabel, avatarSrc, type AvatarGroup, type AvatarPreset } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { Dialog } from '../components/Dialog';
import { Alert, Avatar } from '../components/ui';
import { creditLine } from './credit';
import { chooseBotAvatar, chooseMyAvatar, removeMyAvatar, uploadMyPhoto } from './api';
import { PhotoProblem, preparePhoto } from './photo';

const GROUP_TITLE: Record<AvatarGroup, string> = { man: 'Men', woman: 'Women', hijab: 'Women with a hijab', bot: 'Bots', brain: 'Brain' };
const PERSON_GROUPS: readonly AvatarGroup[] = ['man', 'woman', 'hijab'];
const BOT_GROUPS: readonly AvatarGroup[] = ['bot', 'brain'];

type Target =
  | { kind: 'person'; personId: string }
  | { kind: 'bot'; slug: string; botSlug: string };

function Group({ group, items, current, busy, onPick }: { group: AvatarGroup; items: readonly AvatarPreset[]; current: string | null; busy: boolean; onPick: (id: string) => void }) {
  return (
    <section className="avp-group" aria-label={GROUP_TITLE[group]}>
      <h3 className="avp-h">{GROUP_TITLE[group]}</h3>
      <div className="avp-grid">
        {items.map((p) => (
          <button key={p.id} type="button" className={`avp-cell ${group === 'bot' || group === 'brain' ? 'bot' : ''}`} aria-pressed={current === `preset:${p.id}`} aria-label={p.label} title={p.label} disabled={busy} data-testid={`avatar-${p.id}`} onClick={() => onPick(p.id)}>
            <img src={avatarSrc(`preset:${p.id}`) ?? ''} alt="" loading="lazy" decoding="async" />
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Where a person (or, for a lead or admin, a bot) chooses a picture (PLAN P14-23): one of the built-in pictures, an uploaded photo (people only), or none,
 * which draws the initials. A choice is saved at once; the dialog tells the caller the new value through `onChanged`.
 */
export function AvatarPicker({ name, target, current, onChanged, onClose }: { name: string; target: Target; current: string | null; onChanged: (avatar: string | null) => void; onClose: () => void }) {
  const [value, setValue] = useState<string | null>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const person = target.kind === 'person';

  const run = async (fn: () => Promise<{ avatar: string | null }>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { avatar } = await fn();
      setValue(avatar);
      onChanged(avatar);
    } catch (e) {
      setError(e instanceof PhotoProblem ? e.message : isApiError(e) ? e.message : 'The picture could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const pick = (id: string): void => void run(() => (target.kind === 'person' ? chooseMyAvatar(id) : chooseBotAvatar(target.slug, target.botSlug, id)));
  const clear = (): void => void run(() => (target.kind === 'person' ? removeMyAvatar() : chooseBotAvatar(target.slug, target.botSlug, null)));
  const onFile = (list: FileList | null): void => {
    const chosen = list?.[0];
    if (file.current) file.current.value = '';
    if (chosen) void run(async () => uploadMyPhoto(await preparePhoto(chosen)));
  };

  const personId = target.kind === 'person' ? target.personId : null;
  return (
    <Dialog
      title={person ? 'Profile picture' : `Picture for ${name}`}
      wide
      testId="avatar-picker"
      onClose={onClose}
      footer={<button type="button" className="btn" onClick={onClose} data-autofocus>Done</button>}
    >
      <div className="avp">
        <div className="avp-now">
          <Avatar name={name} kind={person ? 'person' : 'agent'} avatar={value} personId={personId} />
          <div className="avp-now-text">
            <b>{name}</b>
            <span className="avp-sub" data-testid="avatar-current">{value ? (avatarLabel(value) ?? 'Picture') : 'No picture: initials are shown'}</span>
          </div>
          <div className="avp-now-act">
            {person ? (
              <>
                <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Upload a photo" data-testid="avatar-file" onChange={(e) => onFile(e.target.files)} />
                <button type="button" className="btn s" disabled={busy} onClick={() => file.current?.click()} data-testid="avatar-upload">Upload a photo</button>
              </>
            ) : null}
            <button type="button" className="btn s" disabled={busy || value === null} onClick={clear} data-testid="avatar-remove">Use initials</button>
          </div>
        </div>
        {error ? <Alert>{error}</Alert> : null}
        {(person ? PERSON_GROUPS : BOT_GROUPS).map((g) => (
          <Group key={g} group={g} items={OFFERED_AVATAR_PRESETS.filter((p) => p.group === g)} current={value} busy={busy} onPick={pick} />
        ))}
        <p className="avp-credit" data-testid="avatar-credit">{creditLine(person, value)}</p>
      </div>
    </Dialog>
  );
}
