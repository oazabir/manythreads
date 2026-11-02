import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

// The folder a terminal starts in (PLAN P7-09): empty apart from a note, made fresh for one terminal and deleted when it ends. The shell is never started anywhere else.
//
// Where the folders are: inside ONE terminal root that only the server's user can use (checked every time: a real folder, owned by the server's user, nobody else can write to it, so a local
// user cannot plant a link or a look-alike there beforehand), and each terminal gets a folder made by `mkdtemp` (a random name next to the session id, so a name cannot be guessed ahead).
// The server only ever removes a folder it can prove it made: inside the terminal root, named like a session id plus the random part, and the root carries the marker file this module wrote.

const MARKER = '.manythreads-terminal';
const SESSION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID_ONLY = new RegExp(`^${SESSION_ID}$`);
const SESSION_DIR = new RegExp(`^(${SESSION_ID})-[A-Za-z0-9]{6}$`);

export interface Scratch {
  /** The terminal's own folder (`<root>/<session>-<random>`); the shell's folder is inside it. */
  dir: string;
  /** The folder the shell starts in (`<dir>/work`). */
  workDir: string;
  /** Removes everything this terminal made. Safe to call twice. */
  remove(): Promise<void>;
}

export interface ScratchOptions {
  /** The shell runs as another user on the real file system (plain mode) and must be able to walk down to its folder; the root is then `0711`, otherwise `0700`. */
  traversable?: boolean;
}

/** The terminal root, made if it is not there, and proved to be ours. Throws when it is not (the terminal is then not available: it never uses a folder somebody else could write to). */
async function ensureRoot(root: string, traversable: boolean): Promise<string> {
  const abs = resolve(root);
  await mkdir(abs, { recursive: true, mode: 0o700 });
  const info = await lstat(abs);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('the terminal folder is not a plain folder');
  if (typeof process.geteuid === 'function' && info.uid !== process.geteuid()) throw new Error('the terminal folder belongs to another user');
  if ((info.mode & 0o022) !== 0) throw new Error('the terminal folder can be written by other users');
  // other users must be able to walk down to their folder only when the shell runs on the real file system; they can never list the folders
  await chmod(abs, traversable ? 0o711 : 0o700);
  await writeFile(join(abs, MARKER), 'Folders of the manythreads terminal. Every folder in here is deleted when its terminal ends.\n', { mode: 0o600 });
  return abs;
}

export async function makeScratch(root: string, sessionId: string, note: { botSlug: string; startedAt: Date }, options: ScratchOptions = {}): Promise<Scratch> {
  if (!SESSION_ID_ONLY.test(sessionId)) throw new Error('not a session id');
  const abs = await ensureRoot(root, options.traversable === true);
  const dir = await mkdtemp(join(abs, `${sessionId}-`));
  const workDir = join(dir, 'work');
  await mkdir(workDir, { mode: 0o711 });
  await chmod(dir, 0o711);
  await chmod(workDir, 0o755);
  await writeFile(
    join(workDir, 'README.txt'),
    [
      'This is a throwaway test sandbox for the bot "' + note.botSlug + '".',
      'Started ' + note.startedAt.toISOString() + '.',
      '',
      'Nothing here is the bot\'s real work. Files you make disappear when this terminal ends,',
      'and the text this terminal prints is recorded (secrets are masked in the record).',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  let removed = false;
  return {
    dir,
    workDir,
    async remove() {
      if (removed) return;
      removed = true;
      await removeIfOurs(abs, dir);
    },
  };
}

async function removeIfOurs(root: string, dir: string): Promise<void> {
  const abs = resolve(dir);
  const name = abs.slice(root.length + 1);
  if (!abs.startsWith(root + sep) || !SESSION_DIR.test(name)) return;
  const marked = await stat(join(root, MARKER)).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!marked) return;
  await rm(abs, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}

/** Deletes the folders an earlier server process left behind (it died with terminals open). Only folders of this root, only those whose session is not in `live`. */
export async function sweepStale(root: string, live: ReadonlySet<string>): Promise<number> {
  const abs = resolve(root);
  const marked = await stat(join(abs, MARKER)).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!marked) return 0;
  let removed = 0;
  for (const name of await readdir(abs).catch(() => [] as string[])) {
    const match = SESSION_DIR.exec(name);
    if (!match || live.has(match[1] as string)) continue;
    await removeIfOurs(abs, join(abs, name));
    removed += 1;
  }
  return removed;
}
