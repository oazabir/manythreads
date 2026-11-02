import { useState } from 'react';
import type { ChannelMessage } from '@manythreads/shared';
import { fetchChannel } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { Dialog } from '../components/Dialog';
import { message as sentence } from '../screens/memory/inboxWords';
import { sendToMemory } from '../screens/memory/inboxApi';
import { useShell } from '../shell/context';

/**
 * Send to memory: put one message, or the whole thread it belongs to, into the team's memory inbox. The team's inbox reads it and files what is worth keeping
 * as memory that everyone on the team can see, so the dialog says that first. A private channel needs a yes of its own; a direct message belongs to the people
 * in it and cannot be sent.
 */
export function SendToMemoryDialog({ message, onClose, onDone }: { message: ChannelMessage; onClose: () => void; onDone: (said: string) => void }) {
  const { teams } = useShell();
  const channel = useQuery(`send-to-memory:${message.channelId}`, () => fetchChannel(message.channelId));
  const [thread, setThread] = useState(false);
  const [teamOnly, setTeamOnly] = useState(false);
  const [confirmPrivate, setConfirmPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const c = channel.status === 'ok' ? channel.data.channel : null;
  const sendable = c !== null && c.kind === 'channel' && c.teamId !== null;
  const teamName = (c?.teamId ? teams.find((t) => t.id === c.teamId)?.name : null) ?? 'the team';
  const hasThread = message.replyCount > 0 || message.threadRootId !== null;
  const needsYes = c?.private === true;

  const send = async (): Promise<void> => {
    if (!sendable || busy || (needsYes && !confirmPrivate)) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await sendToMemory(message.channelId, message.id, { confirmPrivate, teamOnly, thread: thread && hasThread });
      onDone(answer.duplicate ? 'Already in the memory inbox' : `Sent to ${teamName}’s memory inbox`);
      onClose();
    } catch (e) {
      setBusy(false);
      setError(sentence(e, 'Could not send the message to memory. Try again.'));
    }
  };

  return (
    <Dialog
      title="Send to memory"
      onClose={onClose}
      testId="send-to-memory-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!sendable || busy || (needsYes && !confirmPrivate)} onClick={() => void send()} data-testid="send-to-memory-submit">{busy ? 'Sending…' : 'Send to memory'}</button>
        </>
      }
    >
      {channel.status === 'loading' ? <p className="mi-help" aria-busy="true">Loading…</p> : null}
      {channel.status === 'error' ? <p className="mi-error" role="alert">This message could not be checked just now. Try again.</p> : null}
      {c && !sendable ? (
        <p className="mi-help" data-testid="send-to-memory-refused">Only a message in a team channel can be sent to a team’s memory. A direct message belongs to the people in it.</p>
      ) : null}
      {sendable ? (
        <>
          <p className="mi-help" data-testid="send-to-memory-help">
            The message goes to {teamName}’s memory inbox. It is read and filed as memory, and everyone in {teamName} will be able to see what is filed, with who said it and when.
          </p>
          {needsYes ? (
            <label className="check mi-check" data-testid="send-to-memory-private">
              <input type="checkbox" checked={confirmPrivate} onChange={(e) => setConfirmPrivate(e.target.checked)} data-testid="send-to-memory-private-yes" />
              <span>This channel is private, but everyone in {teamName} will see what is sent. Send it anyway.</span>
            </label>
          ) : null}
          {hasThread ? (
            <label className="check mi-check">
              <input type="checkbox" checked={thread} onChange={(e) => setThread(e.target.checked)} data-testid="send-to-memory-thread" />
              <span>Send the whole thread, not just this message</span>
            </label>
          ) : null}
          <label className="check mi-check">
            <input type="checkbox" checked={teamOnly} onChange={(e) => setTeamOnly(e.target.checked)} data-testid="send-to-memory-team-only" />
            <span>Team only: keep this out of what is shared with other teams</span>
          </label>
        </>
      ) : null}
      {error ? <p className="mi-error" role="alert" data-testid="send-to-memory-error">{error}</p> : null}
    </Dialog>
  );
}
