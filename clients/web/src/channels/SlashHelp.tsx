import { Dialog } from '../components/Dialog';
import { commandChoices, type SlashWho } from './slash';

/** `/help`: every command, what it does, and for the ones this person cannot use right now, why. */
export function SlashHelp({ who, onClose }: { who: SlashWho; onClose: () => void }) {
  return (
    <Dialog
      title="Commands"
      onClose={onClose}
      testId="slash-help"
      footer={
        <button type="button" className="btn primary" onClick={onClose} data-autofocus>
          Close
        </button>
      }
    >
      <p className="dlg-hint">Type a slash at the start of a message to pick one. Anything else that starts with a slash is posted as you typed it.</p>
      <ul className="shelp" aria-label="Commands">
        {commandChoices(who).map(({ command, availability }) => (
          <li key={command.name} className={`shelp-row ${availability.ok ? '' : 'off'}`} data-command={command.name}>
            <code>{command.usage}</code>
            <span className="shelp-what">{command.summary}</span>
            {availability.ok ? null : <small className="shelp-why">{availability.reason}</small>}
          </li>
        ))}
      </ul>
      <p className="dlg-hint">To start a message with a command word as plain text, type two slashes: <code>//ask</code> posts <code>/ask</code>.</p>
    </Dialog>
  );
}
