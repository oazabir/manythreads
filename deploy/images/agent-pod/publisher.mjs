// The publisher (P19-09, docs/plugins/claude-pods.md): the one thing in a Claude or Codex pod that may push a branch and open a pull request (GitHub) or merge request (GitLab).
//
// A bot's run cannot hold a team's GitHub token: the run container has no token, no push Secret and no way to read the publisher's files. Instead the run calls the client
// (`mt-publish`, this file with `client`) which hands one request, with the run's own token, to this server over a Unix socket in a folder the two containers share.
// The server asks the platform `GET /api/runs/self` with that token and gets the run's team and bot and whether the bot's definition grants `tasks.pull_request`.
// The folder to publish from is then /work/<team>/<bot>/<project>, built from the platform's answer and the (checked) project name, never from anything else the caller
// said. The team's token is read from that team's Secret folder alone; another team's folder is never opened. The push itself is mt-publish.sh (the same script the Hermes
// pods use) with MT_SOURCE_DIR set: ONE squashed commit on the origin's main branch tip, as branch `card-<8>`, never `main`, never a force push, the token passed to git and curl without a command line, masked in all output.
// The optional author name and email (the person who asked, for a project that signs commits as the requester) are checked here, then passed on; the script ignores them when the project signs as the bot.
//
//   server:  node publisher.mjs serve
//   client:  mt-publish check <project>
//            mt-publish publish <project> <card id> <tested commit> <title> [<author name> <author email>]      (the request's text on standard input)
//   exit codes are mt-publish.sh's: 0 done, 2 refused, 3 no credential, 4 the branch is not at the tested commit (or the main branch moved and the card must be rebuilt, or there is nothing to publish), 5 push refused,
//   6 GitHub, GitLab or the platform did not answer, 7 token refused. The output lines are the script's: project, provider, pull_request_number, pull_request_url, head_sha (the squashed commit), tested_sha.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const SOCKET = '/run/publish/sock';
const MAX_REQUEST = 32 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_BODY = 8000;
const MAX_AT_ONCE = 4;
const SCRIPT_TIMEOUT_MS = 150_000;

const TEAM = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BOT = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const RUN_TOKEN = /^[A-Za-z0-9_-]{1,200}$/;
const OWNER_KEY = /^_owner\.[a-z0-9][a-z0-9.-]{0,200}$/;

const noDots = (s) => !s.includes('..');
const refuse = (message, code = 2) => ({ code, out: '', err: `${message}\n` });

const AUTHOR_EMAIL = /^[^@<>\s]+@[^@<>\s]+\.[^@<>\s]+$/;
/** The author's name and email as the script wants them (a name of 1 to 100 characters with no line break, < or >; one email address of at most 200 characters), or a reason. */
export function checkAuthor(name, email) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 100 || /[\n\r<>]/.test(name)) return 'the author name is 1 to 100 characters without a line break, < or >';
  if (typeof email !== 'string' || email.length > 200 || !AUTHOR_EMAIL.test(email)) return 'the author email is not an email address';
  return null;
}

/** Asks the platform who the run is. Returns { ok: true, self } or { ok: false, result } (a ready answer for the client). */
export async function whoIs(serverUrl, token, doFetch = fetch) {
  let res;
  try {
    res = await doFetch(`${serverUrl.replace(/\/+$/, '')}/api/runs/self`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return { ok: false, result: refuse('the platform did not answer; try again in a moment', 6) };
  }
  if (res.status === 401) return { ok: false, result: refuse('this run is not valid any more, so it may not publish') };
  if (res.status === 429) return { ok: false, result: refuse('too many requests; wait a moment and try again') };
  if (!res.ok) return { ok: false, result: refuse('the platform did not answer; try again in a moment', 6) };
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, result: refuse('the platform gave an answer that is not understood', 6) };
  }
  const { teamSlug, botSlug, runId, mayPublish } = body ?? {};
  // the answer is checked as the names it is used as: a folder name that could climb out of its folder is refused here, whatever the platform said
  if (typeof teamSlug !== 'string' || typeof botSlug !== 'string' || typeof mayPublish !== 'boolean' || !TEAM.test(teamSlug) || !BOT.test(botSlug) || !noDots(botSlug) || typeof runId !== 'string') {
    return { ok: false, result: refuse('the platform gave an answer that is not understood', 6) };
  }
  return { ok: true, self: { teamSlug, botSlug, runId, mayPublish } };
}

/** The project folder of a bot, only when every part of the path is a real folder under `work` (no link anywhere on the way). */
export function projectFolder(work, self, project) {
  const want = resolve(work, self.teamSlug, self.botSlug, project);
  if (!want.startsWith(resolve(work) + '/')) return null;
  try {
    if (realpathSync(want) !== want || !lstatSync(want).isDirectory()) return null;
  } catch {
    return null;
  }
  return want;
}

const parseDoc = (path) => {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc !== null && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
};

/**
 * Copies the project's push document (and the owner document it points at) of ONE team out of that team's Secret folder into a private folder of regular files, because a
 * Secret's files are links and mt-publish.sh does not follow links. Nothing else in the team's folder is read, and no other team's folder is ever opened.
 * Returns the folder and the token strings read (to scrub the output with).
 */
export function copyPushFiles(teamFolder, project, into) {
  const secrets = [];
  const take = (name) => {
    const from = join(teamFolder, name);
    if (!existsSync(from)) return null;
    const st = statSync(from);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    copyFileSync(from, join(into, name));
    chmodSync(join(into, name), 0o400);
    return parseDoc(join(into, name));
  };
  const doc = take(project);
  if (doc !== null) {
    if (typeof doc.token === 'string' && doc.token !== '') secrets.push(doc.token);
    if (typeof doc.via === 'string' && OWNER_KEY.test(doc.via) && noDots(doc.via)) {
      const owner = take(doc.via);
      if (owner !== null && typeof owner.token === 'string' && owner.token !== '') secrets.push(owner.token);
    }
  }
  return secrets;
}

const scrub = (text, secrets) => secrets.reduce((t, s) => (s.length >= 8 ? t.split(s).join('***') : t), text);

/** Runs mt-publish.sh for one checked request. */
function runScript(options, args, env, body) {
  return new Promise((done) => {
    const child = spawn('bash', [options.script, ...args], { env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let over = false;
    const cap = (text, add) => (text.length + add.length > MAX_OUTPUT ? ((over = true), text) : text + add);
    child.stdout.on('data', (d) => (out = cap(out, d.toString())));
    child.stderr.on('data', (d) => (err = cap(err, d.toString())));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? SCRIPT_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal !== null) done({ code: 6, out, err: err + 'the publish took too long and was stopped\n' });
      else done({ code: code ?? 6, out, err: over ? err + 'the output was cut\n' : err });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(body);
  });
}

/**
 * One request: { op: 'check' | 'publish', token, project, card?, sha?, title?, body?, authorName?, authorEmail? } -> { code, out, err }.
 * options: { serverUrl, work, pushRoot, script, repoUser, doFetch?, timeoutMs?, passEnv? }.
 */
export async function handle(request, options) {
  if (request === null || typeof request !== 'object') return refuse('bad request');
  const { op, token, project } = request;
  if (op !== 'check' && op !== 'publish') return refuse('usage: mt-publish check <project> | publish <project> <card id> <tested commit> <title> [<author name> <author email>]');
  if (typeof token !== 'string' || !RUN_TOKEN.test(token)) return refuse('publishing works only inside a run: there is no run token');
  if (typeof project !== 'string' || !PROJECT.test(project) || !noDots(project)) return refuse('bad project name');
  const asked = await whoIs(options.serverUrl, token, options.doFetch);
  if (!asked.ok) return asked.result;
  const self = asked.self;
  if (!self.mayPublish) return refuse('this bot may not publish: its definition does not grant tasks.pull_request');
  const folder = projectFolder(options.work, self, project);
  if (folder === null) return refuse('no such project folder');
  const teamFolder = join(options.pushRoot, self.teamSlug);
  const args = [op, project];
  let body = '';
  if (op === 'publish') {
    const { card, sha, title } = request;
    const { authorName, authorEmail } = request;
    if (typeof card !== 'string' || typeof sha !== 'string' || typeof title !== 'string') return refuse('usage: mt-publish publish <project> <card id> <tested commit> <title> [<author name> <author email>]');
    // the two author words come together or not at all, and are checked before anything is run
    if ((authorName === undefined) !== (authorEmail === undefined)) return refuse('pass the author name and the author email together, or neither');
    if (authorName !== undefined) {
      const bad = checkAuthor(authorName, authorEmail);
      if (bad !== null) return refuse(bad);
    }
    args.push(card, sha, title);
    if (authorName !== undefined) args.push(authorName, authorEmail);
    body = typeof request.body === 'string' ? request.body.slice(0, MAX_BODY) : '';
  }
  const private_ = mkdtempSync(join(tmpdir(), 'push-'));
  chmodSync(private_, 0o700);
  const secrets = [];
  try {
    // an absent team folder (no token was ever saved for the team) is "no push credential", answered by the script itself
    if (existsSync(teamFolder)) secrets.push(...copyPushFiles(teamFolder, project, private_));
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: private_,
      TMPDIR: private_,
      LANG: 'C.UTF-8',
      MT_SOURCE_DIR: folder,
      MT_PUSH_DIR: private_,
      MT_REPO_USER: options.repoUser,
      ...(options.passEnv ?? {}),
    };
    const result = await runScript(options, args, env, body);
    return { code: result.code, out: scrub(result.out, secrets), err: scrub(result.err, secrets) };
  } finally {
    rmSync(private_, { recursive: true, force: true });
  }
}

/** The Unix socket server. `log` gets words only. */
export function serve(options, log = console.log) {
  let busy = 0;
  mkdirSync(resolve(options.socket, '..'), { recursive: true });
  try {
    unlinkSync(options.socket);
  } catch {
    // none left over
  }
  const server = createServer((conn) => {
    let data = '';
    let answered = false;
    const reply = (result) => {
      if (answered) return;
      answered = true;
      conn.end(JSON.stringify(result) + '\n');
    };
    conn.setEncoding('utf8');
    conn.setTimeout(15_000, () => reply(refuse('the request did not arrive in time')));
    conn.on('error', () => undefined);
    conn.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_REQUEST) return reply(refuse('the request is too large'));
      const end = data.indexOf('\n');
      if (end < 0 || answered) return;
      let request;
      try {
        request = JSON.parse(data.slice(0, end));
      } catch {
        return reply(refuse('bad request'));
      }
      answered = true;
      if (busy >= MAX_AT_ONCE) {
        conn.end(JSON.stringify(refuse('the publisher is busy; try again in a moment', 6)) + '\n');
        return;
      }
      busy += 1;
      handle(request, options)
        .then((result) => {
          log(`publisher: ${request.op} ${String(request.project).slice(0, 61)} -> ${result.code}`);
          conn.end(JSON.stringify(result) + '\n');
        })
        .catch(() => conn.end(JSON.stringify(refuse('the publisher failed', 6)) + '\n'))
        .finally(() => {
          busy -= 1;
        });
    });
  });
  server.listen(options.socket, () => {
    // any process of the run container may connect: what it can do is decided by the run token it presents, not by who it is
    chmodSync(options.socket, 0o666);
  });
  return server;
}

/** The client: one request, the answer printed, the exit code passed on. */
export async function client(argv, env, stdin, stdout, stderr) {
  const [op, project, card, sha, title, authorName, authorEmail] = argv;
  const usage = 'usage: mt-publish check <project> | mt-publish publish <project> <card id> <tested commit> <title> [<author name> <author email>]   (the pull request text on standard input)';
  if (op === 'check' ? argv.length !== 2 : op === 'publish' ? argv.length !== 5 && argv.length !== 7 : true) {
    stderr.write(usage + '\n');
    return 2;
  }
  const token = env.MANYTHREADS_RUN_TOKEN;
  if (!token) {
    stderr.write('publishing works only inside a run: there is no run token\n');
    return 2;
  }
  let body = '';
  if (op === 'publish') body = await readSome(stdin, MAX_BODY, Number(env.MT_PUBLISH_STDIN_MS) || 5000);
  if (op === 'publish' && argv.length === 7) {
    const bad = checkAuthor(authorName, authorEmail);
    if (bad !== null) {
      stderr.write(bad + '\n');
      return 2;
    }
  }
  const request = { op, token, project, ...(op === 'publish' ? { card, sha, title, body, ...(argv.length === 7 ? { authorName, authorEmail } : {}) } : {}) };
  const socket = env.MT_PUBLISH_SOCKET || SOCKET;
  const answer = await new Promise((done) => {
    const conn = connect(socket);
    let text = '';
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(JSON.stringify(request) + '\n'));
    conn.on('data', (c) => (text += c));
    conn.on('error', () => done(null));
    conn.on('close', () => {
      try {
        done(JSON.parse(text));
      } catch {
        done(null);
      }
    });
  });
  if (answer === null) {
    stderr.write('the publisher did not answer: it may not be running in this pod\n');
    return 6;
  }
  if (answer.out) stdout.write(answer.out);
  if (answer.err) stderr.write(answer.err);
  return Number.isInteger(answer.code) ? answer.code : 6;
}

/** Reads up to `max` characters of a stream, stopping at its end or after `ms`, so a run whose standard input never closes is not held. */
function readSome(stream, max, ms) {
  return new Promise((done) => {
    if (stream === null || stream === undefined || stream.isTTY) return done('');
    let text = '';
    const finish = () => {
      clearTimeout(timer);
      stream.removeAllListeners('data');
      stream.removeAllListeners('end');
      stream.removeAllListeners('error');
      stream.pause?.();
      done(text.slice(0, max));
    };
    const timer = setTimeout(finish, ms);
    stream.setEncoding?.('utf8');
    stream.on('data', (c) => {
      text += c;
      if (text.length >= max) finish();
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'client') {
    process.exitCode = await client(rest, process.env, process.stdin, process.stdout, process.stderr);
    process.stdin.destroy();
  } else if (mode === 'serve') {
    const env = process.env;
    const repoUser = env.PUBLISHER_REPO_USER || spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
    const serverUrl = env.PUBLISHER_SERVER_URL;
    if (!serverUrl) {
      console.error('publisher: PUBLISHER_SERVER_URL is not set');
      process.exit(1);
    }
    // these come from the publisher's own environment, which only the pod's definition sets (a test double of GitHub, in the tests)
    const passEnv = {};
    for (const k of ['MT_GITHUB_API', 'MT_GITLAB_API', 'MT_PUSH_URL', 'MT_PR_TRIES', 'MT_PR_WAIT']) if (env[k]) passEnv[k] = env[k];
    serve({
      socket: env.PUBLISHER_SOCKET || SOCKET,
      serverUrl,
      work: env.PUBLISHER_WORK || '/work',
      pushRoot: env.PUBLISHER_PUSH_ROOT || '/etc/publisher-push',
      script: env.PUBLISHER_SCRIPT || '/opt/claude-pod/mt-publish.sh',
      repoUser,
      passEnv,
    });
    console.log('publisher: listening');
  } else {
    console.error('usage: publisher.mjs serve | client <check|publish> ...');
    process.exit(2);
  }
}
