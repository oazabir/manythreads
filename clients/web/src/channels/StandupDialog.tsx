import { useState } from 'react';
import { DEFAULT_STANDUP_QUESTIONS, type Standup } from '@manythreads/shared';
import { fetchStandup, saveStandup } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { Dialog } from '../components/Dialog';
import { fetchBots } from '../screens/bots/api';

/*
 * The stand-up of a channel (P18-04), for a team lead: which bot asks, the questions, the pulse, the days and when the digest is posted. Each member is asked
 * in their conversation with the bot when their own working day starts; people out of office or on Do not disturb are skipped.
 */

const DAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [7, 'Sun'],
] as const;

export function StandupDialog({ channelId, channelName, teamSlug, onClose }: { channelId: string; channelName: string; teamSlug: string; onClose: () => void }) {
  const current = useQuery(`standup:${channelId}`, () => fetchStandup(channelId));
  const bots = useQuery(`bots:${teamSlug}`, () => fetchBots(teamSlug));
  if (current.status !== 'ok' || bots.status !== 'ok') {
    return (
      <Dialog title="Stand-up" onClose={onClose} testId="standup-dialog">
        {current.status === 'error' || bots.status === 'error' ? <p className="dlg-error" role="alert">The stand-up could not be loaded. Close this and try again.</p> : <p className="dlg-text">Loading…</p>}
      </Dialog>
    );
  }
  const slugs = bots.data.bots.filter((b) => b.status === 'active').map((b) => b.slug);
  return <StandupForm channelId={channelId} channelName={channelName} initial={current.data.standup} slugs={slugs} onClose={onClose} />;
}

function StandupForm({ channelId, channelName, initial, slugs, onClose }: { channelId: string; channelName: string; initial: Standup | null; slugs: readonly string[]; onClose: () => void }) {
  const preferred = slugs.includes('standup-collector') ? 'standup-collector' : (slugs[0] ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [botSlug, setBotSlug] = useState(initial?.botSlug && slugs.includes(initial.botSlug) ? initial.botSlug : preferred);
  const [questions, setQuestions] = useState((initial?.questions ?? DEFAULT_STANDUP_QUESTIONS).join('\n'));
  const [pulse, setPulse] = useState(initial?.pulse ?? false);
  const [days, setDays] = useState<number[]>(initial?.days ?? [1, 2, 3, 4, 5]);
  const [digestAt, setDigestAt] = useState(initial?.digestAt ?? '12:00');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const lines = questions.split('\n').map((q) => q.trim()).filter((q) => q !== '');
  const save = async (): Promise<void> => {
    if (lines.length === 0 || lines.length > 5) return setProblem('Write one to five questions, one per line.');
    if (days.length === 0) return setProblem('Pick at least one day.');
    if (!botSlug) return setProblem('The team has no active bot to ask the questions. Add one first, for example the Async stand-up recipe.');
    setBusy(true);
    setProblem(null);
    try {
      await saveStandup(channelId, { enabled, botSlug, questions: lines, pulse, days: [...days].sort(), digestAt });
      onClose();
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : 'The stand-up could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Stand-up in #${channelName}`}
      onClose={onClose}
      testId="standup-dialog"
      wide
      startAtTop
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()} data-testid="standup-save">{busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      <p className="dlg-text">
        Each member of the team is asked these questions in their conversation with the bot when their own working day starts. People who are out of office or on Do not
        disturb are not asked. One digest goes to #{channelName} at the time below, or as soon as everyone has answered.
      </p>
      <div className="dlg-form">
        <label className="su-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="standup-enabled" /> Run the stand-up
        </label>
        <label className="dlg-label" htmlFor="su-bot">Bot that asks</label>
        <select id="su-bot" className="dlg-input" value={botSlug} onChange={(e) => setBotSlug(e.target.value)} data-testid="standup-bot">
          {slugs.length === 0 ? <option value="">No active bot</option> : slugs.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="dlg-label" htmlFor="su-questions">Questions, one per line (at most five)</label>
        <textarea id="su-questions" className="dlg-input" rows={4} value={questions} onChange={(e) => setQuestions(e.target.value)} data-testid="standup-questions" />
        <label className="su-check">
          <input type="checkbox" checked={pulse} onChange={(e) => setPulse(e.target.checked)} data-testid="standup-pulse" /> Also ask for a number from 1 to 5 for how the week feels (the digest shows only the counts)
        </label>
        <span className="dlg-label">Days</span>
        <div className="su-days" role="group" aria-label="Days">
          {DAYS.map(([n, label]) => (
            <label key={n} className="su-check">
              <input type="checkbox" checked={days.includes(n)} onChange={(e) => setDays((d) => (e.target.checked ? [...d, n] : d.filter((x) => x !== n)))} /> {label}
            </label>
          ))}
        </div>
        <label className="dlg-label" htmlFor="su-digest">Digest at (UTC)</label>
        <input id="su-digest" type="time" className="dlg-input" value={digestAt} onChange={(e) => setDigestAt(e.target.value)} data-testid="standup-digest" />
        {problem ? <p className="dlg-error" role="alert">{problem}</p> : null}
      </div>
    </Dialog>
  );
}
