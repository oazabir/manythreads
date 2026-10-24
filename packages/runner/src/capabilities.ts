import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { RunnerCapability } from '@manythreads/shared';

// What this machine can do, as the words SPEC §7.4 gives a runner to advertise: `chrome cdp playwright docker gpu ffmpeg windows
// ios-simulator claude-code codex`, plus `hermes` (the agent itself). A bot's `placement.requires` is matched against this list. Detection
// looks for programs on PATH and never runs one except `docker info`, which says whether the daemon is really there.

export interface Probe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** Whether a program of this name is on PATH. */
  has(program: string): boolean;
  exists(path: string): boolean;
  /** Whether `docker info` succeeds. */
  dockerWorks(): Promise<boolean>;
}

const exts = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] =>
  platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];

export function realProbe(env: NodeJS.ProcessEnv, home: string): Probe {
  const platform = process.platform;
  return {
    platform,
    env,
    home,
    has: (program) => {
      for (const dir of (env['PATH'] ?? '').split(platform === 'win32' ? ';' : ':')) {
        if (dir === '') continue;
        for (const ext of exts(platform, env)) {
          try {
            accessSync(join(dir, program + ext), constants.X_OK);
            return true;
          } catch {
            /* not here */
          }
        }
      }
      return false;
    },
    exists: (path) => existsSync(path),
    dockerWorks: () =>
      new Promise((resolve) => {
        execFile('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 8_000 }, (err) => resolve(err === null));
      }),
  };
}

/** The capabilities this machine advertises, sorted, deduplicated and restricted to the words a runner may use. `extra` is the operator's own list. */
export async function detectCapabilities(probe: Probe, hermesBin: string, extra: readonly string[] = []): Promise<string[]> {
  const found = new Set<string>();
  if (probe.has(hermesBin) || probe.exists(hermesBin)) found.add('hermes');
  if (probe.has('docker') && (await probe.dockerWorks())) found.add('docker');
  if (probe.has('ffmpeg')) found.add('ffmpeg');
  if (['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'].some((p) => probe.has(p))) {
    found.add('chrome');
    found.add('cdp');
  }
  if (probe.has('playwright') || probe.exists(join(probe.home, '.cache', 'ms-playwright'))) found.add('playwright');
  if (probe.has('nvidia-smi')) found.add('gpu');
  if (probe.has('claude')) found.add('claude-code');
  if (probe.has('codex')) found.add('codex');
  if (probe.platform === 'win32') found.add('windows');
  if (probe.platform === 'darwin' && probe.has('xcrun')) found.add('ios-simulator');
  for (const word of extra) found.add(word);
  return [...found].filter((word) => RunnerCapability.safeParse(word).success).sort();
}
