import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A lock kept as a file (`wx` create), so two shards that both find a snapshot missing build it once and the second one waits, then finds it. A lock whose
 * process is gone is taken over. Gives up after `waitMs` with a message that names the file.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, waitMs = 15 * 60_000): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && !alive(holder)) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() > until) throw new Error(`another process (pid ${holder}) has been building a snapshot for more than ${Math.round(waitMs / 60_000)} minutes (${path})`);
      await sleep(1000);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
