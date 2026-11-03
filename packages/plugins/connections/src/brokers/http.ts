import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// One small HTTP client for the brokers (PLAN P8-04): they call a certificate authority or a Kubernetes API whose address an administrator typed in, with a
// bearer token. It follows no redirect (a redirect could carry the token elsewhere), caps the answer, times out, and never puts a header, a body or a token into
// an error: a failure is a short fixed sentence.

export interface BrokerResponse {
  status: number;
  body: string;
}

export interface BrokerRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** PEM of the authority that signed the server's certificate, for a cluster or CA with its own. */
  ca?: string;
  timeoutMs?: number;
  /** The longest answer read, in bytes; more is cut and the call fails. */
  maxBytes?: number;
}

/** A broker could not do its job. `message` is safe to show a model: it names the step, never a value. */
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly code: 'unreachable' | 'refused' | 'bad_answer' | 'bad_config' | 'too_long_lived',
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

/** The address of a service, which must be plain http(s) with no credentials in it. */
export function parseServiceUrl(text: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BrokerError(`The ${what} address is not a web address.`, 'bad_config');
  }
  // plain http would send a long-lived bootstrap token in clear text; only a test double is allowed to speak it
  const allowed = process.env['NODE_ENV'] === 'test' ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new BrokerError(`The ${what} address must be https and carry no user name or password.`, 'bad_config');
  }
  return url;
}

export function send(req: BrokerRequest): Promise<BrokerResponse> {
  const url = parseServiceUrl(req.url, 'service');
  const maxBytes = req.maxBytes ?? 1_000_000;
  return new Promise((resolve, reject) => {
    const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const r = doRequest(
      url,
      {
        method: req.method,
        headers: { ...(req.headers ?? {}), ...(req.body !== undefined ? { 'content-length': String(Buffer.byteLength(req.body)) } : {}) },
        timeout: req.timeoutMs ?? 10_000,
        ...(req.ca !== undefined && url.protocol === 'https:' ? { ca: req.ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new BrokerError('The service answered with more than was expected.', 'bad_answer'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => reject(new BrokerError('The connection to the service broke.', 'unreachable')));
      },
    );
    r.on('timeout', () => {
      r.destroy();
      reject(new BrokerError('The service did not answer in time.', 'unreachable'));
    });
    r.on('error', () => reject(new BrokerError('The service could not be reached.', 'unreachable')));
    r.end(req.body);
  });
}
