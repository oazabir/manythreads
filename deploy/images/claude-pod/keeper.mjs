// The keeper (P19-06): the one thing in a Claude Code pod that may write the sign-in Secret. The CLI renews its access token and writes a new pair into
// /state/claude/.credentials.json; if the pod restarted from the Secret's older copy, the refresh token in it would be dead. So when the file has changed, parses, and has held the
// same size and modification time for two seconds (the CLI writes it in more than one step), the keeper copies it back, byte for byte, into the Secret
// `claude-<runner>-credentials`. It has a ServiceAccount that can get and patch that one Secret and nothing else; the bridge and the bots have no Kubernetes identity.
// It reads the file and never prints it, and it logs words only. The stable-for-two-seconds rule is provisional until P19-01 (s) is measured with the real CLI.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';

export const STABLE_MS = 2000;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * One look at the file. `state` is kept between calls: { pushed: sha of what the Secret holds, seen: { size, mtimeMs, since } }.
 * Returns 'pushed', 'waiting' (changed, not yet still), 'same' (nothing new), 'bad' (does not parse) or 'missing'.
 */
export async function lookOnce({ file, state, now, push }) {
  let st;
  let buf;
  try {
    st = statSync(file);
    buf = readFileSync(file);
  } catch {
    return 'missing';
  }
  const digest = sha(buf);
  if (state.pushed === undefined) {
    // the first look: this is the copy the pod started from, which the Secret already holds
    state.pushed = digest;
    return 'same';
  }
  if (digest === state.pushed) {
    state.seen = undefined;
    return 'same';
  }
  if (!state.seen || state.seen.size !== st.size || state.seen.mtimeMs !== st.mtimeMs) {
    state.seen = { size: st.size, mtimeMs: st.mtimeMs, since: now() };
    return 'waiting';
  }
  if (now() - state.seen.since < STABLE_MS) return 'waiting';
  try {
    const doc = JSON.parse(buf.toString('utf8'));
    if (typeof doc?.claudeAiOauth?.refreshToken !== 'string') return 'bad';
  } catch {
    return 'bad';
  }
  await push(buf);
  state.pushed = digest;
  state.seen = undefined;
  return 'pushed';
}

/** A fetch-shaped call over node:https that trusts the cluster's own CA (Node's fetch cannot be given one without a package). */
export function httpsWithCa(caFile) {
  const ca = readFileSync(caFile);
  return (url, init) =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(url, { method: init.method, headers: init.headers, ca }, (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      });
      req.on('error', reject);
      req.end(init.body);
    });
}

/** A merge patch of the Secret's one key, through the Kubernetes API with the keeper's own token. */
export function kubePush({ namespace, secret, tokenFile, host, port, doFetch }) {
  return async (buf) => {
    const token = readFileSync(tokenFile, 'utf8').trim();
    const res = await doFetch(`https://${host}:${port}/api/v1/namespaces/${namespace}/secrets/${secret}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ data: { '.credentials.json': buf.toString('base64') } }),
    });
    if (!res.ok) throw new Error(`the Secret was not updated (${res.status})`);
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const push = kubePush({
    namespace: env.KEEPER_NAMESPACE,
    secret: env.KEEPER_SECRET,
    tokenFile: env.KEEPER_TOKEN_FILE ?? '/var/run/secrets/keeper/token',
    host: env.KUBERNETES_SERVICE_HOST,
    port: env.KUBERNETES_SERVICE_PORT ?? '443',
    doFetch: httpsWithCa(env.KEEPER_CA_FILE ?? '/var/run/secrets/keeper/ca.crt'),
  });
  const state = {};
  const file = env.KEEPER_FILE ?? '/state/claude/.credentials.json';
  console.log('keeper: watching the sign-in file');
  setInterval(() => {
    lookOnce({ file, state, now: Date.now, push })
      .then((r) => {
        if (r === 'pushed') console.log('keeper: the renewed sign-in file was saved to its Secret');
        else if (r === 'bad') console.warn('keeper: the sign-in file changed but does not read as a sign-in; not saved');
      })
      .catch((err) => console.warn(`keeper: ${err instanceof Error ? err.message : 'failed'}`));
  }, 1000);
}
