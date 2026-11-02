import { TerminalServerFrame, type TerminalClientFrame } from '@manythreads/shared';

/*
 * How the Terminal view talks to the shell (PLAN P7-09). The view only knows `TerminalTransport`: a real one over a WebSocket, and a scripted one for the mock mode and the tests. Nothing
 * else in the view knows which it has.
 */

export type TerminalTransport = {
  send(frame: TerminalClientFrame): void;
  /** Closes the connection. The server kills the shell when it closes. */
  close(): void;
  /** Called with every valid frame from the server. */
  onFrame(listener: (frame: TerminalServerFrame) => void): void;
  /** Called once, when the connection is gone for any reason. `code` is the close code (1006 when the connection dropped). */
  onClose(listener: (info: { code: number; reason: string }) => void): void;
};

/** The part of a WebSocket the real transport uses, so a test can stand in for one. */
export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

const CONNECTING = 0;
const OPEN = 1;

/** A transport over one socket. A frame that is not valid is a reason to close, so a broken server cannot put odd text on the screen. */
export function socketTransport(socket: SocketLike): TerminalTransport {
  let frameListener: ((f: TerminalServerFrame) => void) | null = null;
  let closeListener: ((i: { code: number; reason: string }) => void) | null = null;
  let told = false;
  const queued: string[] = [];
  const tell = (code: number, reason: string): void => {
    if (told) return;
    told = true;
    closeListener?.({ code, reason });
  };
  socket.onopen = () => {
    for (const d of queued.splice(0)) socket.send(d);
  };
  socket.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      socket.close(1003, 'text only');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(ev.data);
    } catch {
      socket.close(1007, 'bad frame');
      return;
    }
    const parsed = TerminalServerFrame.safeParse(value);
    if (!parsed.success) {
      socket.close(1007, 'bad frame');
      return;
    }
    frameListener?.(parsed.data);
  };
  socket.onclose = (ev) => tell(ev.code, ev.reason);
  socket.onerror = () => tell(1006, 'connection error');
  return {
    send(frame) {
      const data = JSON.stringify(frame);
      if (socket.readyState === OPEN) socket.send(data);
      else if (socket.readyState === CONNECTING) queued.push(data);
    },
    close() {
      try {
        socket.close(1000, 'closed');
      } catch {
        /* already gone */
      }
      tell(1000, 'closed');
    },
    onFrame(l) {
      frameListener = l;
    },
    onClose(l) {
      closeListener = l;
    },
  };
}

export const browserTerminalTransport = (url: string): TerminalTransport => socketTransport(new WebSocket(url) as unknown as SocketLike);
