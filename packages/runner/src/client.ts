import { hostname } from 'node:os';
import {
  RUNNER_MAX_FRAME_BYTES,
  RUNNER_PROTOCOL_VERSION,
  ServerToRunner,
  type RunnerToServer,
} from '@manythreads/shared';
import WebSocket from 'ws';
import { connectUrl, type RunnerConfig } from './config.ts';
import { createJobRunner, type JobRunner, type JobRunnerDeps } from './job.ts';

// The runner's one outbound connection (SPEC §7.4, PLAN P6-06): connect with the bearer token, say hello, heartbeat, run the jobs the server
// sends, and when the connection goes, stop what is running (nobody is left to read it) and connect again with a growing pause.

export const RUNNER_VERSION = '0.1.0';

export interface RunnerClientOptions {
  config: RunnerConfig;
  token: string;
  /** The capabilities to advertise, detected on every connect (a docker daemon can appear or go). */
  capabilities(): Promise<string[]>;
  log(line: string): void;
  /** Overrides for tests: the job runner's dependencies. */
  jobDeps?: Partial<Pick<JobRunnerDeps, 'removeContainers' | 'env' | 'spawn' | 'uid'>>;
  /** Pause between attempts, in milliseconds; the default grows from one second to a minute. Tests pass small numbers. */
  backoffMs?: (attempt: number) => number;
}

export interface RunnerClient {
  /** Resolves when `stop` is called (the loop runs until then). */
  readonly done: Promise<void>;
  stop(): Promise<void>;
  /** The team and name the server gave in its last welcome; null before the first. */
  readonly welcomed: { runnerId: string; name: string; teamSlug: string } | null;
  readonly jobs: JobRunner | null;
}

export const defaultBackoff = (attempt: number): number => {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.75 + Math.random() * 0.5));
};

export function startRunnerClient(options: RunnerClientOptions): RunnerClient {
  const { config, token, log } = options;
  const backoff = options.backoffMs ?? defaultBackoff;
  let stopping = false;
  let socket: WebSocket | null = null;
  let welcomed: RunnerClient['welcomed'] = null;
  let jobs: JobRunner | null = null;
  let wake: (() => void) | undefined;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  /** One connection, from open to close. Resolves with whether it was accepted (welcomed) and whether the server refused our token. */
  const session = (): Promise<{ welcomed: boolean; unauthorized: boolean }> =>
    new Promise((resolve) => {
      let accepted = false;
      let heartbeat: NodeJS.Timeout | undefined;
      const ws = new WebSocket(connectUrl(config.server), {
        headers: { authorization: `Bearer ${token}` },
        maxPayload: 16 * 1024 * 1024,
        handshakeTimeout: 15_000,
      });
      socket = ws;
      let local: JobRunner | null = null;
      const send = (frame: RunnerToServer): void => {
        const text = JSON.stringify(frame);
        // A frame over the server's limit would end the connection: this is a bug in the sender, not something to retry.
        if (Buffer.byteLength(text) > RUNNER_MAX_FRAME_BYTES) {
          log(`dropped a ${frame.type} frame of ${Buffer.byteLength(text)} bytes (the limit is ${RUNNER_MAX_FRAME_BYTES})`);
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      };

      ws.on('open', () => {
        void options.capabilities().then((capabilities) => {
          send({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, version: RUNNER_VERSION, host: hostname(), capabilities, maxJobs: config.maxJobs });
        });
      });

      ws.on('message', (data) => {
        let frame;
        try {
          frame = ServerToRunner.parse(JSON.parse(data.toString('utf8')));
        } catch {
          log('the server sent a frame this runner does not understand; closing');
          ws.close(1008, 'invalid frame');
          return;
        }
        if (frame.type === 'welcome') {
          if (config.name !== null && config.name !== frame.name) {
            log(`this token belongs to the runner "${frame.name}", not "${config.name}"; stopping`);
            stopping = true;
            ws.close(1000, 'wrong runner');
            return;
          }
          accepted = true;
          welcomed = { runnerId: frame.runnerId, name: frame.name, teamSlug: frame.teamSlug };
          local = createJobRunner({ config, send, log, ...options.jobDeps });
          jobs = local;
          log(`connected as runner "${frame.name}" of team ${frame.teamSlug}`);
          heartbeat = setInterval(() => send({ type: 'heartbeat', running: local?.running ?? 0 }), frame.heartbeatSeconds * 1000);
          heartbeat.unref?.();
          return;
        }
        if (!local || !welcomed) return;
        if (frame.type === 'job') local.start(frame, welcomed.teamSlug);
        else local.stop(frame.jobId);
      });

      let unauthorized = false;
      ws.on('unexpected-response', (_req, res) => {
        unauthorized = res.statusCode === 401 || res.statusCode === 403;
        log(`the server refused the connection (HTTP ${res.statusCode})`);
        res.resume();
      });
      ws.on('error', (err) => log(`connection error: ${err.message}`));
      ws.on('close', (code, reason) => {
        if (heartbeat) clearInterval(heartbeat);
        if (code === 1008 && reason.toString() === 'unauthorized') unauthorized = true;
        const finish = (): void => resolve({ welcomed: accepted, unauthorized });
        // The connection is gone, so nobody reads what is running: stop it, wait until it is cleaned up, then reconnect.
        if (local) void local.stopAll().finally(finish);
        else finish();
      });
    });

  const done = (async (): Promise<void> => {
    let attempt = 0;
    while (!stopping) {
      const result = await session();
      socket = null;
      if (stopping) break;
      attempt = result.welcomed ? 0 : attempt + 1;
      const pause = result.unauthorized ? 60_000 : backoff(attempt);
      if (result.unauthorized) log('the server did not accept this runner token (unknown, revoked or for an archived team); retrying in a minute');
      else log(`disconnected; reconnecting in ${Math.round(pause / 1000)}s`);
      await sleep(pause);
    }
  })();

  return {
    done,
    get welcomed() {
      return welcomed;
    },
    get jobs() {
      return jobs;
    },
    async stop() {
      stopping = true;
      wake?.();
      socket?.close(1000, 'runner stopping');
      await done;
    },
  };
}
