import { fetchPushState, subscribePush, unsubscribePush } from '../api/endpoints';
import { browserLabel, keyBytes, pushSupport, type PushSupport } from './settingsModel';

/*
 * Browser push from the page's side (PLAN P14-09): the service worker at `/sw.js` receives the push when no tab is open and shows it; this module
 * registers it, asks the browser's permission, signs the browser up with the server and takes it off again. Every function is safe to call where the
 * browser has no such feature: it answers "unsupported" instead of throwing.
 */

/** True inside the desktop app (clients/desktop): it raises its own system alerts and has no push service, so browser push is left off there. */
export const inDesktopApp = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const hasFeatures = (): boolean => !inDesktopApp() && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined';

function permission(): NotificationPermission | 'unsupported' {
  try {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  } catch {
    return 'unsupported';
  }
}

/** Registers the service worker (once per page load; the browser keeps the registration). Null where it cannot. */
export async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!hasFeatures()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

/** What the settings screen shows: whether push can work here, and whether this browser is signed up. */
export interface PushStatus {
  support: PushSupport;
  /** This browser has a push subscription. */
  subscribed: boolean;
  /** The server's public key; null when the server cannot push. */
  publicKey: string | null;
  /** How many browsers the person has signed up in all. */
  devices: number;
}

export async function readPushStatus(): Promise<PushStatus> {
  let serverAvailable = false;
  let publicKey: string | null = null;
  let devices = 0;
  try {
    const state = await fetchPushState();
    serverAvailable = state.available;
    publicKey = state.publicKey;
    devices = state.subscriptions;
  } catch {
    /* an older server: push is then unavailable */
  }
  const support = pushSupport({ serviceWorker: hasFeatures(), pushManager: hasFeatures(), permission: permission(), serverAvailable });
  let subscribed = false;
  if (support !== 'unsupported') {
    try {
      const reg = (await navigator.serviceWorker.getRegistration('/')) ?? null;
      subscribed = (await reg?.pushManager.getSubscription()) != null;
    } catch {
      subscribed = false;
    }
  }
  return { support, subscribed, publicKey, devices };
}

/** Asks the browser for permission, subscribes it with the server's key and tells the server. Throws a message fit to show a person. */
export async function enablePush(publicKey: string): Promise<void> {
  const reg = await registerWorker();
  if (!reg) throw new Error('This browser cannot receive push notifications.');
  const result = permission() === 'granted' ? 'granted' : await Notification.requestPermission();
  if (result !== 'granted') throw new Error('Notifications were not allowed. You can allow them in your browser’s settings.');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys['auth']) throw new Error('The browser did not give a usable push address.');
  await subscribePush({ endpoint: json.endpoint, keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] }, label: browserLabel(navigator.userAgent) });
}

/** Takes this browser off push: on the server first (so nothing more is sent), then in the browser. Never throws. */
export async function disablePush(): Promise<void> {
  if (!hasFeatures()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await unsubscribePush(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  } catch {
    /* nothing more can be done from here */
  }
}
