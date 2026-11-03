import { createHash, createPrivateKey, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerError, parseServiceUrl, send } from './http.ts';
import { clampLifetime, MAX_CREDENTIAL_SECONDS } from './limits.ts';

// The SSH broker (SPEC §11, PLAN P8-04). A connection never holds a key a person could copy and keep: it holds the right to ask a certificate authority (step-ca
// here; Teleport would be a second signer behind the same interface) for a certificate. For each call this file makes a fresh key pair in memory, has the
// authority sign the public half for ONE principal for at most an hour, checks the certificate that came back (the key is ours, the name is the one asked for,
// it ends within the hour), connects with it and throws everything away. The private key lives in a private temporary folder for the length of one command.

// --- keys and certificates (OpenSSH wire format) -------------------------------------------------------------------------------------------------------

const str = (data: Buffer | string): Buffer => {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

export interface SshKeyPair {
  /** `ssh-ed25519 AAAA…` */
  publicLine: string;
  /** The key in OpenSSH's own file format (no passphrase), for `ssh -i`. Never logged, never returned. */
  privateFile: string;
  /** The public key as it is sent to the authority: base64 of the wire format. */
  publicWire: Buffer;
}

/** A new Ed25519 key pair, in the formats `ssh` and a certificate authority read. */
export function generateSshKeyPair(): SshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url');
  const publicWire = Buffer.concat([str('ssh-ed25519'), str(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([check, check, str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str('')]);
  const padding = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
  const blob = Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), u32(1), str(publicWire), str(priv)]);
  const lines = blob.toString('base64').match(/.{1,70}/g)!.join('\n');
  return {
    publicLine: `ssh-ed25519 ${publicWire.toString('base64')}`,
    privateFile: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicWire,
  };
}

export interface CertificateFacts {
  keyId: string;
  principals: string[];
  validAfter: Date;
  validBefore: Date;
  /** `user` (1) or `host` (2). */
  userCertificate: boolean;
  /** The public key the certificate vouches for, base64 of the wire format. */
  publicWire: Buffer;
}

/** Reads what an Ed25519 certificate says about itself. Throws for anything else: this broker only ever asks for, and accepts, Ed25519 user certificates. */
export function readEd25519Certificate(line: string): CertificateFacts {
  const [type, body] = line.trim().split(/\s+/);
  if (type !== 'ssh-ed25519-cert-v01@openssh.com' || !body) throw new BrokerError('The authority answered with a certificate of a kind this broker does not use.', 'bad_answer');
  const buf = Buffer.from(body, 'base64');
  let at = 0;
  const readU32 = (): number => {
    const v = buf.readUInt32BE(at);
    at += 4;
    return v;
  };
  const readU64 = (): bigint => {
    const v = buf.readBigUInt64BE(at);
    at += 8;
    return v;
  };
  const readStr = (): Buffer => {
    const n = readU32();
    if (at + n > buf.length) throw new RangeError('short');
    const v = buf.subarray(at, at + n);
    at += n;
    return v;
  };
  try {
    if (readStr().toString() !== type) throw new RangeError('type');
    readStr(); // nonce
    const pub = readStr();
    readU64(); // serial
    const kind = readU32();
    const keyId = readStr().toString('utf8');
    const principalsBlob = readStr();
    const principals: string[] = [];
    for (let p = 0; p < principalsBlob.length; ) {
      const n = principalsBlob.readUInt32BE(p);
      principals.push(principalsBlob.subarray(p + 4, p + 4 + n).toString('utf8'));
      p += 4 + n;
    }
    const validAfter = readU64();
    const validBefore = readU64();
    return {
      keyId,
      principals,
      validAfter: new Date(Number(validAfter) * 1000),
      validBefore: validBefore >= 2n ** 53n ? new Date(8.64e15) : new Date(Number(validBefore) * 1000),
      userCertificate: kind === 1,
      publicWire: Buffer.concat([str('ssh-ed25519'), str(pub)]),
    };
  } catch {
    throw new BrokerError('The authority’s certificate could not be read.', 'bad_answer');
  }
}

// --- the signer: what asks an authority for a certificate ----------------------------------------------------------------------------------------------

export interface SignRequest {
  /** `ssh-ed25519 AAAA…` */
  publicLine: string;
  /** The one account name the certificate is good for. */
  principal: string;
  /** Written into the certificate and the authority's log: who asked, for which task. */
  keyId: string;
  ttlSeconds: number;
}

/** Anything that turns a public key into a certificate line: step-ca today; Teleport would be another implementation. */
export interface SshSigner {
  sign(request: SignRequest): Promise<string>;
}

export interface StepCaConfig {
  /** `https://ca.example:9000` */
  caUrl: string;
  /** The name of the JWK provisioner configured on the authority. */
  provisioner: string;
  /** That provisioner's private key as a JWK (EC P-256). It can ask for certificates, nothing else; it never leaves the connection. */
  provisionerKey: string;
  /** PEM of the authority's root certificate (for https). */
  ca?: string;
  now?: () => Date;
}

const b64u = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/** A step-ca one-time token (a signed claim that says exactly which certificate may be signed), made with the provisioner's key. */
function mintStepToken(config: StepCaConfig, signUrl: string, request: SignRequest, now: Date): string {
  let jwk: { kid?: string; crv?: string; [key: string]: unknown };
  try {
    jwk = JSON.parse(config.provisionerKey) as typeof jwk;
  } catch {
    throw new BrokerError('The provisioner key of this connection is not a key.', 'bad_config');
  }
  if (jwk.crv !== 'P-256' || typeof jwk.kid !== 'string') throw new BrokerError('The provisioner key of this connection must be a P-256 JWK with a key id.', 'bad_config');
  const key = createPrivateKey({ key: jwk as never, format: 'jwk' });
  const iat = Math.floor(now.getTime() / 1000);
  const claims = {
    iss: config.provisioner,
    aud: signUrl,
    sub: request.keyId,
    jti: randomUUID(),
    iat,
    nbf: iat - 5,
    exp: iat + 300,
    step: {
      ssh: {
        certType: 'user',
        keyID: request.keyId,
        principals: [request.principal],
        publicKey: request.publicLine.split(' ')[1],
        validAfter: new Date(now.getTime() - 5000).toISOString(),
        validBefore: new Date(now.getTime() + request.ttlSeconds * 1000).toISOString(),
      },
    },
  };
  const signingInput = `${b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: jwk.kid }))}.${b64u(JSON.stringify(claims))}`;
  const signature = createSign('SHA256').update(signingInput).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64u(signature)}`;
}

/** The signer for a step-ca authority (`POST /1.0/ssh/sign` with a one-time token). */
export function stepCaSigner(config: StepCaConfig): SshSigner {
  const base = parseServiceUrl(config.caUrl, 'certificate authority');
  const signUrl = `${base.origin}/1.0/ssh/sign`;
  return {
    async sign(request) {
      const now = (config.now ?? (() => new Date()))();
      const ott = mintStepToken(config, signUrl, request, now);
      const res = await send({
        url: signUrl,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          publicKey: request.publicLine.split(' ')[1],
          ott,
          certType: 'user',
          keyID: request.keyId,
          principals: [request.principal],
          validAfter: new Date(now.getTime() - 5000).toISOString(),
          validBefore: new Date(now.getTime() + request.ttlSeconds * 1000).toISOString(),
        }),
        ...(config.ca !== undefined ? { ca: config.ca } : {}),
      });
      if (res.status === 401 || res.status === 403) throw new BrokerError('The certificate authority refused to sign for this connection.', 'refused');
      if (res.status !== 200 && res.status !== 201) throw new BrokerError('The certificate authority could not sign a certificate.', 'unreachable');
      let crt: unknown;
      try {
        crt = (JSON.parse(res.body) as { crt?: unknown }).crt;
      } catch {
        throw new BrokerError('The certificate authority’s answer was not understood.', 'bad_answer');
      }
      if (typeof crt !== 'string' || crt === '') throw new BrokerError('The certificate authority’s answer was not understood.', 'bad_answer');
      return `ssh-ed25519-cert-v01@openssh.com ${crt}`;
    },
  };
}

// --- the broker --------------------------------------------------------------------------------------------------------------------------------------

export interface IssuedSshCredential {
  keyPair: SshKeyPair;
  /** The signed certificate, one line, for `CertificateFile`. */
  certificateLine: string;
  expiresAt: Date;
}

const PRINCIPAL = /^[a-z_][a-z0-9_.-]{0,31}$/;
const KEY_ID = /^[A-Za-z0-9:._@-]{1,200}$/;

/**
 * A fresh key pair and a certificate for it, valid for `ttlSeconds` (ten minutes to one hour), for exactly one principal. What the authority answers is checked
 * before it is believed: it must vouch for the key made here, name only the asked principal, be a user certificate, and end within the hour.
 */
export async function issueSshCredential(signer: SshSigner, input: { principal: string; keyId: string; ttlSeconds?: number; now?: () => Date }): Promise<IssuedSshCredential> {
  if (!PRINCIPAL.test(input.principal)) throw new BrokerError('The account name of this connection is not valid.', 'bad_config');
  if (!KEY_ID.test(input.keyId)) throw new BrokerError('The certificate label is not valid.', 'bad_config');
  const now = (input.now ?? (() => new Date()))();
  const ttlSeconds = clampLifetime(input.ttlSeconds);
  const keyPair = generateSshKeyPair();
  const certificateLine = await signer.sign({ publicLine: keyPair.publicLine, principal: input.principal, keyId: input.keyId, ttlSeconds });
  const facts = readEd25519Certificate(certificateLine);
  if (!facts.userCertificate || !facts.publicWire.equals(keyPair.publicWire)) throw new BrokerError('The authority’s certificate is not for the key made for this task.', 'bad_answer');
  if (facts.principals.length !== 1 || facts.principals[0] !== input.principal) throw new BrokerError('The authority’s certificate names accounts that were not asked for.', 'bad_answer');
  if (!Number.isFinite(facts.validBefore.getTime())) throw new BrokerError('The authority’s certificate has no usable end time, so it was thrown away.', 'too_long_lived');
  if (facts.validBefore.getTime() > now.getTime() + MAX_CREDENTIAL_SECONDS * 1000 + 60_000) {
    throw new BrokerError('The authority gave a certificate that lives longer than one hour, so it was thrown away.', 'too_long_lived');
  }
  if (facts.validBefore.getTime() <= now.getTime()) throw new BrokerError('The authority’s certificate has already ended.', 'bad_answer');
  return { keyPair, certificateLine, expiresAt: facts.validBefore };
}

// --- running one command -----------------------------------------------------------------------------------------------------------------------------

export interface SshTarget {
  /** `host` or `host:port` */
  host: string;
  user: string;
  /** The lines of a `known_hosts` file: the servers this connection will trust. Without it nothing is run (no first-use trust). */
  knownHosts: string;
}

export type SshAnswer =
  | { ok: true; exitCode: number; stdout: string; stderr: string; truncated: boolean }
  | { ok: false; code: 'unreachable' | 'timeout' | 'refused'; message: string };

/** The most of each output kept, in characters. */
export const MAX_OUTPUT_CHARS = 20_000;
const HOST = /^([A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?|\[[0-9a-fA-F:.]{2,45}\])(:\d{1,5})?$/;

export function splitHost(host: string): { name: string; port: number } | null {
  if (!HOST.test(host)) return null;
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(host)!;
  const port = m[2] === undefined ? 22 : Number(m[2]);
  const name = m[1]!.replace(/^\[|\]$/g, '');
  return port >= 1 && port <= 65535 ? { name, port } : null;
}

/** What `ssh` is started with; exported so a test can read the arguments. Everything that could widen the session is switched off. */
export function sshArguments(files: { key: string; certificate: string; knownHosts: string }, target: { name: string; port: number; user: string }, command: string, timeoutSeconds: number): string[] {
  return [
    '-T',
    // no user or system ssh config (a ProxyJump or Include there would apply to every call)
    '-F', '/dev/null',
    '-i', files.key,
    '-o', `CertificateFile=${files.certificate}`,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${files.knownHosts}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ProxyCommand=none',
    '-o', 'LogLevel=ERROR',
    '-o', `ConnectTimeout=${Math.min(15, timeoutSeconds)}`,
    '-p', String(target.port),
    `${target.user}@${target.name}`,
    '--',
    command,
  ];
}

export interface RunOptions {
  /** The ssh program; tests point it at a stand-in. */
  binary?: string;
  timeoutMs?: number;
}

/** Runs ONE command with a credential, in a private folder that is removed before this returns, whatever happens. */
export async function runSshCommand(credential: IssuedSshCredential, target: SshTarget, command: string, opts: RunOptions = {}): Promise<SshAnswer> {
  const parsed = splitHost(target.host);
  if (!parsed) return { ok: false, code: 'refused', message: 'That is not a valid host name.' };
  if (!PRINCIPAL.test(target.user)) return { ok: false, code: 'refused', message: 'The account name of this connection is not valid.' };
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const dir = await mkdtemp(join(tmpdir(), 'mt-ssh-'));
  try {
    await chmod(dir, 0o700);
    const files = { key: join(dir, 'key'), certificate: join(dir, 'key-cert.pub'), knownHosts: join(dir, 'known_hosts') };
    await writeFile(files.key, credential.keyPair.privateFile, { mode: 0o600 });
    await writeFile(files.certificate, `${credential.certificateLine}\n`, { mode: 0o600 });
    await writeFile(files.knownHosts, `${target.knownHosts.trim()}\n`, { mode: 0o600 });
    return await new Promise<SshAnswer>((resolve) => {
      // no agent socket, no inherited environment: the child sees only what it needs
      const child = spawn(opts.binary ?? 'ssh', sshArguments(files, { ...parsed, user: target.user }, command, Math.ceil(timeoutMs / 1000)), {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir, LANG: 'C' },
      });
      let stdout = '';
      let stderr = '';
      let truncated = false;
      const keep = (current: string, chunk: Buffer): string => {
        if (current.length >= MAX_OUTPUT_CHARS) {
          truncated = true;
          return current;
        }
        const next = current + chunk.toString('utf8');
        if (next.length > MAX_OUTPUT_CHARS) truncated = true;
        return next.slice(0, MAX_OUTPUT_CHARS);
      };
      child.stdout.on('data', (c: Buffer) => (stdout = keep(stdout, c)));
      child.stderr.on('data', (c: Buffer) => (stderr = keep(stderr, c)));
      let done = false;
      const finish = (answer: SshAnswer): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(answer);
      };
      // on the deadline the answer is given at once: a helper the child started could keep its pipes open after the kill
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ ok: false, code: 'timeout', message: 'The command did not finish in time and was stopped.' });
      }, timeoutMs);
      child.on('error', () => finish({ ok: false, code: 'unreachable', message: 'The ssh program could not be started on the server.' }));
      child.on('close', (code) => {
        // 255 is ssh's own failure (could not connect, host key not trusted, certificate refused), not the command's
        if (code === 255) return finish({ ok: false, code: 'unreachable', message: 'The host could not be reached, is not one this connection trusts, or refused the certificate.' });
        finish({ ok: true, exitCode: code ?? -1, stdout, stderr, truncated });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A short, non-secret label for a certificate: the run and the connection, so the authority's log shows what it was for. */
export const sshKeyId = (parts: { runId: string; connection: string }): string => `mt:${parts.connection}:${createHash('sha256').update(parts.runId).digest('hex').slice(0, 16)}`;
