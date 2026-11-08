import { useState } from 'react';
import type { CallState } from './controller';
import { RecordDotIcon } from './icons';
import { planRecordConsent, recordPromptCopy, recordingChip, recordingReason, showsRecordButton } from './model';
import { callController } from './store';

/*
 * Recording (PLAN P15-15). Off for the whole workspace until an admin turns it on. Then anyone in the call may turn it on for the call, and each person answers
 * "Record my voice?" on their own. Sound is saved only while everyone in the call has said yes, and stops the moment someone who has not joins. The chip tells everybody,
 * the whole time, whether sound is being saved or the call is waiting for someone.
 */

/** The record button; nothing is drawn where the workspace does not allow recording. */
export function RecordingToggle({ call }: { call: CallState }) {
  const c = callController();
  const [busy, setBusy] = useState(false);
  const rec = call.recording;
  if (!showsRecordButton(rec) || !rec) return null;
  const reason = recordingReason(rec);
  const label = rec.on ? 'Stop recording' : 'Record the call';
  return (
    <button
      type="button"
      className={`call-btn ${rec.on ? 'rec' : ''}`}
      aria-pressed={rec.on}
      aria-label={label}
      aria-disabled={(!rec.on && reason !== null) || undefined}
      title={!rec.on && reason ? reason : label}
      disabled={busy}
      data-testid="call-record"
      onClick={() => {
        if (!rec.on && reason) {
          c.notify(reason);
          return;
        }
        setBusy(true);
        void c.setRecording(!rec.on).finally(() => setBusy(false));
      }}
    >
      <RecordDotIcon />
    </button>
  );
}

/** The chip beside the controls while recording is on. */
export function RecordingChip({ call }: { call: CallState }) {
  const chip = recordingChip(call.recording, call.present);
  if (!chip) return null;
  return (
    <span className={`call-chip ${chip.tone}`} title={chip.title} role="status" data-testid="call-rec-chip">
      {chip.label}
    </span>
  );
}

/** "Record my voice?" for a person who has not answered while recording is on. */
export function RecordConsentPrompt({ call }: { call: CallState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (planRecordConsent(call.recording) !== 'ask') return null;
  const copy = recordPromptCopy();
  const choose = async (answer: 'yes' | 'no'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await callController().answerRecordConsent(answer);
    } catch {
      setError('Could not save your answer. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="call-consent" role="group" aria-label={copy.title} data-testid="call-record-consent">
      <b className="call-consent-title">{copy.title}</b>
      <p className="call-consent-body">{copy.body}</p>
      {error ? <p className="call-consent-error" role="alert">{error}</p> : null}
      <div className="call-consent-actions">
        <button type="button" className="btn primary s" disabled={busy} onClick={() => void choose('yes')} data-testid="record-consent-yes">{copy.yes}</button>
        <button type="button" className="btn s" disabled={busy} onClick={() => void choose('no')} data-testid="record-consent-no">{copy.no}</button>
      </div>
    </div>
  );
}
