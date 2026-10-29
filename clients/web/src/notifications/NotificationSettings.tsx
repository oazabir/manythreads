import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { LEVEL_LABEL, type NotificationLevel } from '@manythreads/shared';
import { fetchNotificationKeywords, saveNotificationKeywords } from '../api/endpoints';
import { isApiError } from '../api/client';
import { isAdmin, useSession } from '../app/session';
import { Alert, Toggle } from '../components/ui';
import { levelsStore } from './levelsStore';
import { disablePush, enablePush, readPushStatus, registerWorker, type PushStatus } from './push';
import { LEVEL_HELP, LEVEL_ORDER, PUSH_SUPPORT_TEXT, addKeyword, channelTitle } from './settingsModel';
import { browserAlerts, notificationStore } from './store';
import { useNotifications } from './Bell';

const KINDS = [
  { kind: 'mention', label: 'Mentions and keywords', help: 'Someone names you, or writes one of your keywords.' },
  { kind: 'reply', label: 'Replies in threads you follow', help: 'A new reply in a thread you started, joined or followed.' },
  { kind: 'dm', label: 'Direct messages', help: 'A message in a conversation just with you or a small group.' },
] as const;

function LevelSelect({ value, label, onChange, allowDefault = false }: { value: NotificationLevel | null; label: string; onChange: (v: NotificationLevel | null) => void; allowDefault?: boolean }) {
  return (
    <select
      className="nset-select"
      aria-label={label}
      value={value ?? 'default'}
      onChange={(e) => onChange(e.target.value === 'default' ? null : (e.target.value as NotificationLevel))}
    >
      {allowDefault ? <option value="default">Use the default</option> : null}
      {LEVEL_ORDER.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
    </select>
  );
}

/** What tells you, per kind: the in-app switches the inbox has always had, now in the account settings. */
function KindsBlock() {
  const snap = useNotifications();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void notificationStore.loadPrefs();
  }, []);
  const prefs = snap.prefs;
  return (
    <div className="nset-group" data-testid="notification-kinds">
      <h3 className="nset-h">What tells you</h3>
      {error ? <Alert>{error}</Alert> : null}
      {KINDS.map((k) => (
        <div className="nset-row" key={k.kind}>
          <div>
            <div>{k.label}</div>
            <div className="nset-help">{k.help}</div>
          </div>
          <Toggle label={k.label} checked={prefs ? prefs[k.kind].inApp : true} disabled={prefs === null} onChange={(on) => { setError(null); notificationStore.setInApp(k.kind, on).catch((e: Error) => setError(e.message)); }} />
        </div>
      ))}
    </div>
  );
}

/** The level every team channel starts with, and the channels the person set themself. */
function ChannelsBlock() {
  const session = useSession();
  const snap = useSyncExternalStore(levelsStore.subscribe, levelsStore.snapshot);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void levelsStore.load();
  }, []);
  const levels = snap.levels;
  const fail = (e: unknown): void => setError(e instanceof Error ? e.message : 'Could not save the setting.');
  return (
    <div className="nset-group" data-testid="notification-levels">
      <h3 className="nset-h">Channels</h3>
      <p className="nset-help">What a channel may interrupt you with. Change one from the bell in its header.</p>
      {error ? <Alert>{error}</Alert> : null}
      {levels === null ? (
        <p className="nset-help" aria-busy={snap.status === 'loading' || undefined}>{snap.status === 'error' ? 'Could not load your channel settings.' : 'Loading…'}</p>
      ) : (
        <>
          <div className="nset-row">
            <div>
              <div>Default for team channels</div>
              <div className="nset-help">{LEVEL_HELP[levels.workspaceDefault]}{isAdmin(session) ? '' : ' A workspace admin sets this.'}</div>
            </div>
            {isAdmin(session) ? (
              <LevelSelect value={levels.workspaceDefault} label="Default for team channels" onChange={(v) => { setError(null); if (v) levelsStore.setWorkspaceDefault(v).catch(fail); }} />
            ) : (
              <span className="chip" data-testid="workspace-default">{LEVEL_LABEL[levels.workspaceDefault]}</span>
            )}
          </div>
          {levels.channels.length === 0 ? (
            <p className="nset-help" data-testid="no-channel-levels">You have not changed any channel. Direct messages always tell you unless you change them.</p>
          ) : (
            <ul className="nset-list">
              {levels.channels.map((c) => (
                <li className="nset-row" key={c.channelId} data-testid="channel-level">
                  <span>{channelTitle(c)}</span>
                  <LevelSelect value={c.level} label={`Level for ${channelTitle(c)}`} allowDefault onChange={(v) => { setError(null); levelsStore.setChannel(c, v).catch(fail); }} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** The person's own words: a message that holds one tells them as a mention would. */
function KeywordsBlock() {
  const [keywords, setKeywords] = useState<string[] | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    fetchNotificationKeywords().then((r) => live && setKeywords(r.keywords), () => live && setError('Could not load your keywords.'));
    return () => {
      live = false;
    };
  }, []);
  const save = async (next: string[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setKeywords((await saveNotificationKeywords(next)).keywords);
      setText('');
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not save your keywords.');
    } finally {
      setBusy(false);
    }
  };
  const add = (e: FormEvent): void => {
    e.preventDefault();
    if (keywords === null || text.trim() === '') return;
    const r = addKeyword(keywords, text);
    if ('problem' in r) setError(r.problem);
    else void save(r.keywords);
  };
  return (
    <div className="nset-group" data-testid="notification-keywords">
      <h3 className="nset-h">Keywords</h3>
      <p className="nset-help">A message with one of these words tells you, as if you were named. Whole words only, capital letters do not matter. It applies in channels you have joined and in your direct messages.</p>
      {keywords !== null && keywords.length > 0 ? (
        <ul className="nset-chips">
          {keywords.map((k) => (
            <li key={k} className="chip" data-testid="keyword">
              {k}
              <button type="button" className="nset-x" aria-label={`Remove ${k}`} disabled={busy} onClick={() => void save(keywords.filter((x) => x !== k))}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="nset-add" onSubmit={add} noValidate>
        <input className="nset-input" aria-label="New keyword" placeholder="A word or short phrase" maxLength={80} value={text} onChange={(e) => setText(e.target.value)} disabled={keywords === null} />
        <button type="submit" className="btn" disabled={busy || keywords === null || text.trim() === ''}>Add</button>
      </form>
      {error ? <p className="nset-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** Alerts while the app is open, and push for when it is closed. */
function BrowserBlock() {
  const snap = useNotifications();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = (): void => void readPushStatus().then(setStatus);
  useEffect(() => {
    void registerWorker().then(() => readPushStatus()).then(setStatus);
    void notificationStore.loadPrefs();
  }, []);

  const alertsOn = snap.prefs !== null && (snap.prefs.mention.browser || snap.prefs.reply.browser || snap.prefs.dm.browser);
  const alertsState = browserAlerts();
  const setAlerts = async (on: boolean): Promise<void> => {
    setError(null);
    try {
      if (on && alertsState === 'default') {
        const result = await Notification.requestPermission();
        if (result !== 'granted') throw new Error('Notifications were not allowed. You can allow them in your browser’s settings.');
      }
      await notificationStore.setBrowserAlerts(on);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the setting.');
    }
  };
  const togglePush = async (on: boolean): Promise<void> => {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      if (on) {
        if (!status.publicKey) throw new Error(PUSH_SUPPORT_TEXT.unavailable);
        await enablePush(status.publicKey);
      } else {
        await disablePush();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : isApiError(e) ? (e as Error).message : 'Could not change the setting.');
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const pushNote = status && status.support !== 'ready' ? PUSH_SUPPORT_TEXT[status.support] : null;
  return (
    <div className="nset-group" data-testid="notification-browser">
      <h3 className="nset-h">This browser</h3>
      {error ? <Alert>{error}</Alert> : null}
      {alertsState === 'unsupported' || alertsState === 'denied' ? null : (
        <div className="nset-row">
          <div>
            <div>Alerts while manythreads is open</div>
            <div className="nset-help">A system alert when something tells you and this tab is in the background.</div>
          </div>
          <Toggle label="Alerts while manythreads is open" checked={alertsOn && alertsState === 'granted'} disabled={snap.prefs === null} onChange={(on) => void setAlerts(on)} />
        </div>
      )}
      <div className="nset-row">
        <div>
          <div>Push notifications</div>
          <div className="nset-help">
            {pushNote ?? 'Alerts even when manythreads is closed. A private channel or a direct message shows who and where, not what was said.'}
            {status && status.devices > 0 ? ` ${status.devices === 1 ? 'You have 1 browser' : `You have ${status.devices} browsers`} signed up.` : ''}
          </div>
        </div>
        <Toggle label="Push notifications" checked={status?.subscribed === true} disabled={busy || status === null || status.support !== 'ready'} onChange={(on) => void togglePush(on)} />
      </div>
    </div>
  );
}

/** The Notifications section of the account settings (PLAN P14-09). */
export function NotificationSettings() {
  return (
    <section className="block" aria-labelledby="acc-notifications" data-landmark="notifications" data-testid="notification-settings">
      <h2 className="bh" id="acc-notifications">Notifications</h2>
      <div className="block-body nset">
        <KindsBlock />
        <ChannelsBlock />
        <KeywordsBlock />
        <BrowserBlock />
      </div>
    </section>
  );
}
