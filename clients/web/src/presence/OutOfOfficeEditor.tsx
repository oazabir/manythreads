import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { MyPresence } from '@manythreads/shared';
import { fetchRoster, fetchTeams } from '../api/endpoints';
import { useSession } from '../app/session';
import { useQuery } from '../app/useQuery';
import { useNow } from './hooks';
import { VISIBLE_NOTE, deviceTimeZone } from './settingsModel';
import { dayAfter, oooDraftOf, oooRequest, sameOoo, todayFor, type OooDraft } from './oooModel';
import { useSaver } from './PresencePanels';
import { presenceStore } from './store';

/** The people to offer as a delegate: everyone on the rosters of the person's own teams (the server accepts anyone on the workspace), once each, by name. */
function useDelegateChoices(selfId: string): { id: string; name: string }[] {
  const q = useQuery('ooo-delegates', async () => {
    const { teams } = await fetchTeams();
    const rosters = await Promise.all(teams.map((t) => fetchRoster(t.slug).catch(() => ({ members: [] }))));
    const byId = new Map<string, string>();
    for (const r of rosters) for (const m of r.members) byId.set(m.personId, m.displayName);
    return [...byId].map(([id, name]) => ({ id, name }));
  });
  return q.status === 'ok' ? q.data.filter((p) => p.id !== selfId).sort((a, b) => a.name.localeCompare(b.name)) : [];
}

/** Out of office: a switch, the first day back, who to ask meanwhile and a short note. Shown on the profile card; the approvals plugin reads it later (P18-03). */
export function OutOfOfficeEditor({ me }: { me: MyPresence }) {
  const id = useId();
  const session = useSession();
  const now = useNow(60_000);
  const save = useSaver();
  const saved = oooDraftOf(me.outOfOffice);
  const [draft, setDraft] = useState<OooDraft>(saved);
  const [note, setNote] = useState<string | null>(null);
  const choices = useDelegateChoices(session.person.id);
  // Dates are read in the saved zone; with none saved, saving first saves this device's zone (like the hours editor), so the day means what the screen says
  const device = deviceTimeZone();
  const zone = me.timeZone ?? device ?? 'UTC';
  const today = todayFor(zone, now);
  const dirty = !sameOoo(draft, saved);
  // a note saved on another device (or ended by itself) shows up here as long as nothing has been typed in this form
  const touched = useRef(false);
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    if (!touched.current) setDraft(JSON.parse(savedKey) as OooDraft);
  }, [savedKey]);
  const change = (patch: Partial<OooDraft>): void => {
    touched.current = true;
    setDraft((d) => ({ ...d, ...patch }));
    setNote(null);
    save.fail(null);
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const built = oooRequest(draft, today, session.person.id);
    if (!built.ok) return save.fail(built.problem);
    void save.run(
      async () => {
        if (draft.on && me.timeZone === null && device !== null) await presenceStore.saveProfile({ timeZone: device });
        await presenceStore.saveProfile(built.body);
      },
      () => {
        touched.current = false;
        setNote(draft.on ? 'Out of office saved.' : 'Out of office is off.');
      },
    );
  };
  // a delegate who is not on the lists above (another team's person, saved earlier) stays selectable so saving does not drop them
  const known = draft.delegate === '' || choices.some((c) => c.id === draft.delegate);
  return (
    <form className="pr-group" onSubmit={submit} noValidate data-testid="ooo-editor">
      <div className="pr-switch-row">
        <div>
          <div id={`${id}-sw`}>I am out of office</div>
          <p className="pr-help">{VISIBLE_NOTE} Your profile card shows the day you are back and who to ask meanwhile. It ends by itself on that day.</p>
        </div>
        <button type="button" role="switch" aria-checked={draft.on} aria-labelledby={`${id}-sw`} className={`tog ${draft.on ? 'on' : ''}`} onClick={() => change({ on: !draft.on })} data-testid="ooo-switch" />
      </div>
      {draft.on ? (
        <>
          <div className="pr-inline">
            <div className="pr-field">
              <label className="pr-label" htmlFor={`${id}-back`}>First day back</label>
              <input id={`${id}-back`} className="pr-input" type="date" min={dayAfter(today)} value={draft.returnsOn} onChange={(e) => change({ returnsOn: e.target.value })} data-testid="ooo-returns" />
              <p className="pr-help" data-testid="ooo-zone">Read in <b>{zone.replaceAll('_', ' ')}</b>{me.timeZone === null && device ? ' (this device’s zone; it is saved with the note)' : ''}.</p>
            </div>
            <div className="pr-field pr-grow">
              <label className="pr-label" htmlFor={`${id}-who`}>Ask meanwhile</label>
              <select id={`${id}-who`} className="pr-input" value={draft.delegate} onChange={(e) => change({ delegate: e.target.value })} data-testid="ooo-delegate">
                <option value="">Nobody in particular</option>
                {known ? null : <option value={draft.delegate}>The person you chose before</option>}
                {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <div className="pr-field">
            <label className="pr-label" htmlFor={`${id}-msg`}>Note (optional)</label>
            <input id={`${id}-msg`} className="pr-input" type="text" maxLength={200} value={draft.message} onChange={(e) => change({ message: e.target.value })} placeholder="Back online on the 15th, urgent things go to Nadia" data-testid="ooo-message" />
          </div>
        </>
      ) : null}
      {save.error ? <p className="pr-error" role="alert" data-testid="ooo-error">{save.error}</p> : null}
      {note ? <p className="pr-ok" role="status" data-testid="ooo-note">{note}</p> : null}
      <div className="pr-actions">
        <button type="submit" className="btn primary" disabled={save.busy || !dirty} data-testid="ooo-save">Save out of office</button>
      </div>
    </form>
  );
}
