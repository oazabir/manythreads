import { generateKeyPairSync, createVerify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// A local double of the one call a smallstep step-ca makes for an SSH user certificate (`POST /1.0/ssh/sign`, P8-04): it checks the one-time token the way the
// real authority does (signature of the provisioner, audience, the claims agreeing with the request) and signs with a REAL certificate authority key through
// `ssh-keygen -s`, so what comes back is a certificate `ssh` itself accepts. Needs `ssh-keygen` (check `fakeStepCaAvailable()`).

const run = promisify(execFile);

export async function fakeStepCaAvailable(): Promise<boolean> {
  try {
    await run('ssh-keygen', ['-?']).catch((e: { code?: unknown; stderr?: string }) => {
      if (e.code === 'ENOENT') throw e;
    });
    return true;
  } catch {
    return false;
  }
}

export interface FakeStepCa {
  url: string;
  provisioner: string;
  /** The provisioner's private key as the connection stores it (a P-256 JWK with a `kid`). Test data only. */
  provisionerKey: string;
  /** The authority's public key line, for a server's `TrustedUserCAKeys` or a test's `ssh-keygen -L`. */
  caPublicLine: string;
  /** The `/ssh/sign` bodies it received (the one-time token left out). */
  requests: Array<{ publicKey: string; certType: string; keyID: string; principals: string[]; validAfter: string; validBefore: string }>;
  /** Make the authority ignore what was asked for: sign for this long (seconds), or for these principals. */
  overrideLifetimeSeconds: number | null;
  overridePrincipals: string[] | null;
  /** Answer the next call with this status instead of signing. */
  failNext(status: number): void;
  stop(): Promise<void>;
}

const b64uToBuf = (s: string): Buffer => Buffer.from(s, 'base64url');

export async function startFakeStepCa(): Promise<FakeStepCa> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-fake-ca-'));
  const caKey = join(dir, 'ca');
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fake-step-ca', '-f', caKey]);
  const caPublicLine = (await readFile(`${caKey}.pub`, 'utf8')).trim();
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kid = 'fake-provisioner-kid';
  const provisionerKey = JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid });
  const verifyKey = publicKey;
  const provisioner = 'mt-provisioner';
  const state = { override: null as number | null, principals: null as string[] | null, fail: [] as number[], n: 0 };
  const requests: FakeStepCa['requests'] = [];
  let url = '';

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, doc: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(doc));
      void (async () => {
        if (req.method !== 'POST' || req.url !== '/1.0/ssh/sign') return send(404, { message: 'not found' });
        const failing = state.fail.shift();
        if (failing !== undefined) return send(failing, { message: 'forced' });
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { publicKey: string; ott: string; certType: string; keyID: string; principals: string[]; validAfter: string; validBefore: string };
        const [h, c, sig] = body.ott.split('.');
        if (!h || !c || !sig) return send(401, { message: 'bad token' });
        const header = JSON.parse(b64uToBuf(h).toString()) as { alg: string; kid: string };
        const claims = JSON.parse(b64uToBuf(c).toString()) as { iss: string; aud: string; exp: number; nbf: number; step?: { ssh?: { principals?: string[]; keyID?: string; publicKey?: string } } };
        const valid = createVerify('SHA256').update(`${h}.${c}`).verify({ key: verifyKey, dsaEncoding: 'ieee-p1363' }, b64uToBuf(sig));
        const now = Date.now() / 1000;
        const ssh = claims.step?.ssh;
        if (!valid || header.alg !== 'ES256' || header.kid !== kid || claims.iss !== provisioner || claims.aud !== `${url}/1.0/ssh/sign` || claims.exp < now || claims.nbf > now + 1) {
          return send(401, { message: 'token rejected' });
        }
        if (!ssh || ssh.publicKey !== body.publicKey || ssh.keyID !== body.keyID || JSON.stringify(ssh.principals) !== JSON.stringify(body.principals)) return send(401, { message: 'token does not match the request' });
        requests.push({ publicKey: body.publicKey, certType: body.certType, keyID: body.keyID, principals: body.principals, validAfter: body.validAfter, validBefore: body.validBefore });
        const ttl = state.override ?? Math.max(1, Math.round((Date.parse(body.validBefore) - Date.now()) / 1000));
        const work = join(dir, `req-${++state.n}`);
        await writeFile(`${work}.pub`, `ssh-ed25519 ${body.publicKey}\n`);
        await run('ssh-keygen', ['-q', '-s', caKey, '-I', body.keyID, '-n', (state.principals ?? body.principals).join(','), '-V', `-1m:+${ttl}s`, `${work}.pub`]);
        const cert = (await readFile(`${work}-cert.pub`, 'utf8')).trim().split(/\s+/)[1]!;
        send(201, { crt: cert });
      })().catch(() => send(500, { message: 'fake failure' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    provisioner,
    provisionerKey,
    caPublicLine,
    requests,
    get overrideLifetimeSeconds() {
      return state.override;
    },
    set overrideLifetimeSeconds(v: number | null) {
      state.override = v;
    },
    get overridePrincipals() {
      return state.principals;
    },
    set overridePrincipals(v: string[] | null) {
      state.principals = v;
    },
    failNext: (status) => void state.fail.push(status),
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}
