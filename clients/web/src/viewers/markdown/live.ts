import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

// The browser end of live pages (PLAN P6-09): one Yjs document per page over the team's socket route, awareness for cursors, and the server's
// commit notice. The document's text is the markdown source, so what everyone types is exactly what the session commits — no conversion between
// an editor model and the file.

export type LiveStatus = 'connecting' | 'synced' | 'offline';

export interface LivePeer {
  clientId: number;
  actorId: string;
  name: string;
  color: string;
  cursor: { anchor: number; head: number } | null;
}

/** The slice of a WebSocket the document uses; a test can hand in an in-memory pair. */
export interface LiveSocket {
  readyState: number;
  binaryType?: string;
  send(data: Uint8Array): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export const OPEN = 1;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** A stable colour per actor, so the same person keeps the same cursor colour across reloads and pages. */
export function peerColor(actorId: string): string {
  let hash = 0;
  for (let i = 0; i < actorId.length; i += 1) hash = (hash * 31 + actorId.charCodeAt(i)) >>> 0;
  const hues = [8, 28, 48, 150, 178, 202, 224, 260, 292, 330];
  return `hsl(${hues[hash % hues.length]} 72% 45%)`;
}

/**
 * Replace the document's text with `next`, keeping the unchanged prefix and suffix: a keystroke becomes one small insert or delete, not a
 * rewrite of the page (which would move everyone else's cursor to the end on every key).
 */
export function applyTextChange(text: Y.Text, next: string): void {
  const previous = text.toString();
  if (previous === next) return;
  let start = 0;
  const shortest = Math.min(previous.length, next.length);
  while (start < shortest && previous.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let endPrevious = previous.length;
  let endNext = next.length;
  while (endPrevious > start && endNext > start && previous.charCodeAt(endPrevious - 1) === next.charCodeAt(endNext - 1)) {
    endPrevious -= 1;
    endNext -= 1;
  }
  if (endPrevious > start) text.delete(start, endPrevious - start);
  if (endNext > start) text.insert(start, next.slice(start, endNext));
}

/** Everybody else's cursor in the document, newest state per actor. */
export function peersOf(awareness: Awareness, self: string): LivePeer[] {
  const byActor = new Map<string, LivePeer>();
  for (const [clientId, raw] of awareness.getStates()) {
    const state = raw as { actorId?: unknown; user?: { name?: unknown }; cursor?: { anchor?: unknown; head?: unknown } };
    if (typeof state.actorId !== 'string' || state.actorId === self) continue;
    const anchor = typeof state.cursor?.anchor === 'number' ? state.cursor.anchor : null;
    const head = typeof state.cursor?.head === 'number' ? state.cursor.head : anchor;
    byActor.set(state.actorId, {
      clientId,
      actorId: state.actorId,
      name: typeof state.user?.name === 'string' ? state.user.name : 'Someone',
      color: peerColor(state.actorId),
      cursor: anchor === null || head === null ? null : { anchor, head },
    });
  }
  return [...byActor.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The line and column (0-based) of a character offset, for drawing a caret over a monospace textarea. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, at);
  const line = (before.match(/\n/g) ?? []).length;
  const column = at - (before.lastIndexOf('\n') + 1);
  return { line, column };
}

export interface LiveDocumentOptions {
  actorId: string;
  name: string;
  /** The page's socket URL (`liveUrl`): it carries the path, and the session cookie authenticates the upgrade. */
  url: string;
  socketFactory?: (url: string) => LiveSocket;
  onStatus?: (status: LiveStatus) => void;
  onCommit?: (notice: { sha: string; editors: number }) => void;
}

export class LiveDocument {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly text = this.doc.getText('body');
  private socket: LiveSocket | null = null;
  private readonly options: LiveDocumentOptions;
  private readonly url: string;
  private closed = false;

  constructor(options: LiveDocumentOptions) {
    this.options = options;
    this.url = options.url;
    this.awareness.setLocalStateField('actorId', options.actorId);
    this.awareness.setLocalStateField('user', { name: options.name });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.send(encoding.toUint8Array(encoder));
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      this.sendAwareness([...added, ...updated, ...removed]);
    });
  }

  connect(): void {
    const factory = this.options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as LiveSocket);
    const socket = factory(this.url);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      const step = encoding.createEncoder();
      encoding.writeVarUint(step, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(step, this.doc);
      this.send(encoding.toUint8Array(step));
      this.sendAwareness([this.doc.clientID]);
      this.options.onStatus?.('synced');
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = (event) => {
      if (!this.closed) this.options.onStatus?.('offline');
      void event;
    };
    socket.onerror = () => this.options.onStatus?.('offline');
    this.options.onStatus?.('connecting');
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
    this.awareness.destroy();
    this.doc.destroy();
  }

  /** The local editor's text, diffed into the document (one insert/delete instead of a rewrite). */
  edit(next: string): void {
    this.doc.transact(() => applyTextChange(this.text, next), 'local');
  }

  setCursor(anchor: number, head = anchor): void {
    this.awareness.setLocalStateField('cursor', { anchor, head });
  }

  peers(): LivePeer[] {
    return peersOf(this.awareness, this.options.actorId);
  }

  private send(bytes: Uint8Array): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(bytes);
  }

  private sendAwareness(clients: number[]): void {
    if (clients.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, clients));
    this.send(encoding.toUint8Array(encoder));
  }

  private receive(raw: unknown): void {
    if (typeof raw === 'string') {
      try {
        const notice = JSON.parse(raw) as { type?: string; sha?: string; editors?: number };
        if (notice.type === 'committed' && typeof notice.sha === 'string') this.options.onCommit?.({ sha: notice.sha, editors: notice.editors ?? 0 });
      } catch {
        /* not a notice */
      }
      return;
    }
    const data = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike);
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'remote');
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
      return;
    }
    if (type === MESSAGE_AWARENESS) applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), 'remote');
  }
}

/** The page's live socket URL on this origin (the URL carries no credential: the session cookie rides the upgrade). */
export function liveUrl(location: { protocol: string; host: string }, teamSlug: string, path: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/api/teams/${encodeURIComponent(teamSlug)}/pages/live?path=${encodeURIComponent(path)}`;
}
