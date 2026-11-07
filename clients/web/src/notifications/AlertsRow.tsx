import { useState } from 'react';
import { browserAlerts, notificationStore } from './store';

/** "Allow browser alerts?": asks the browser once, then stores the choice as the person's setting. Absent where there is no Notification API. */
export function AlertsRow({ prefsOn, prefsKnown }: { prefsOn: boolean; prefsKnown: boolean }) {
  const [state, setState] = useState(browserAlerts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state === 'unsupported' || state === 'denied') return null;
  if (state === 'granted' && (prefsOn || !prefsKnown)) return null;
  const allow = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let result = state;
      if (state === 'default') result = (await Notification.requestPermission()) as typeof state;
      setState(browserAlerts());
      if (result === 'granted') await notificationStore.setBrowserAlerts(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn alerts on.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ntf-allow" data-testid="allow-alerts">
      <span>Allow browser alerts?</span>
      <button type="button" className="btn s" disabled={busy} onClick={() => void allow()}>Allow</button>
      {error ? <span className="ntf-error" role="alert">{error}</span> : null}
    </div>
  );
}
