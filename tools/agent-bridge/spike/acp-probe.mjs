// A measuring client for the Agent Client Protocol (ACP): JSON-RPC over an agent's stdin and stdout.
// It has no dependencies on purpose, so the raw lines on the wire are exactly what is recorded.
// Used by the P25-01 spike (docs/spikes/acp-measured.md). Not shipped; the bridge's driver (P25-03) uses the SDK.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const now = () => Number(process.hrtime.bigint() / 1000000n);

/** Remove what must never be kept: our own fake tokens, any secret values given, home folders, e-mail addresses. */
export function makeSanitiser({ secrets = [], replacements = [] } = {}) {
  const exact = secrets.filter((s) => s && s.length >= 8);
  return (text) => {
    let out = text;
    for (const s of exact) out = out.split(s).join('<redacted>');
    for (const [from, to] of replacements) out = out.split(from).join(to);
    out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
    out = out.replace(/\b(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, '<redacted>');
    out = out.replace(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/g, 'ABCD-12345'); // a one-time device code
    out = out.replace(/\b(Bearer|bearer) [A-Za-z0-9._~+/=-]{12,}/g, '$1 <redacted>');
    return out;
  };
}

const SCRUB_KEYS = new Set(['email', 'organization', 'organizationName', 'orgName', 'accountUuid', 'organizationUuid', 'displayName', 'userId', 'user_id']);
/** Replaces the value of keys that name a person or an account, wherever they sit in a message. */
export function scrubKeys(v) {
  if (Array.isArray(v)) return v.map(scrubKeys);
  // The operator's own slash commands and skills are not part of the protocol facts; the list is kept empty.
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, k === 'availableCommands' ? [] : SCRUB_KEYS.has(k) && typeof x === 'string' ? '<redacted>' : scrubKeys(x)]),
    );
  return v;
}

export class Recorder {
  constructor(file, sanitise) {
    this.file = file;
    this.sanitise = sanitise;
    this.count = 0;
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '');
    }
  }
  add(dir, msg, t, extra = {}) {
    this.count++;
    if (!this.file) return;
    appendFileSync(this.file, this.sanitise(JSON.stringify({ t, dir, ...extra, msg: scrubKeys(msg) })) + '\n');
  }
}

/** One adapter process and its JSON-RPC conversation. dir: "c2a" client to agent, "a2c" agent to client. */
export class AcpAgent {
  constructor({ name, cmd, args = [], env = {}, cwd, recorder, onRequest }) {
    this.name = name;
    this.recorder = recorder;
    this.onRequest =
      onRequest ??
      (async () => ({
        error: { code: -32601, message: 'client has no such method' },
      }));
    this.t0 = now();
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.listeners = [];
    this.stderr = '';
    this.exited = null;
    this.child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.pid = this.child.pid;
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal, t: now() - this.t0 };
      for (const p of this.pending.values()) p.reject(new Error(`process exited (${code ?? signal})`));
    });
    this.child.stderr.on('data', (d) => (this.stderr += d.toString()));
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.#line(line);
      }
    });
  }
  elapsed() {
    return now() - this.t0;
  }
  #line(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.recorder?.add('a2c', { notJson: line.slice(0, 300) }, this.elapsed());
      return;
    }
    this.recorder?.add('a2c', msg, this.elapsed());
    if (msg.method && msg.id !== undefined) {
      void (async () => {
        let reply;
        try {
          reply = await this.onRequest(msg, this);
        } catch (e) {
          reply = { error: { code: -32603, message: String(e?.message ?? e) } };
        }
        this.#write(reply && 'error' in reply ? { jsonrpc: '2.0', id: msg.id, error: reply.error } : { jsonrpc: '2.0', id: msg.id, result: reply?.result ?? {} });
      })();
    } else if (msg.method) {
      const n = { ...msg, t: this.elapsed() };
      this.notifications.push(n);
      for (const l of this.listeners) l(n);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve({ ...msg, rtt: this.elapsed() - p.sentAt });
      }
    }
  }
  #write(msg) {
    this.recorder?.add('c2a', msg, this.elapsed());
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
  /** Resolves with the whole response ({result} or {error}); never throws on a JSON-RPC error. */
  request(method, params, { timeoutMs = 120000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${method} after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        sentAt: this.elapsed(),
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }
  /** Calls fn(notification) for each session/update seen from now on. Returns an unsubscribe function. */
  listen(fn) {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((l) => l !== fn));
  }
  waitFor(pred, timeoutMs = 60000) {
    const have = this.notifications.find(pred);
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (off(), reject(new Error('waitFor timeout'))), timeoutMs);
      const off = this.listen((n) => {
        if (!pred(n)) return;
        clearTimeout(timer);
        off();
        resolve(n);
      });
    });
  }
  async stop() {
    if (this.exited) return this.exited;
    try {
      this.child.stdin.end();
    } catch {
      // the process is already gone
    }
    await Promise.race([new Promise((r) => this.child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    if (!this.exited) {
      try {
        process.kill(-this.pid, 'SIGTERM');
      } catch {
        // the process is already gone
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!this.exited) {
      try {
        process.kill(-this.pid, 'SIGKILL');
      } catch {
        // the process is already gone
      }
    }
    return this.exited;
  }
}

/** A tiny MCP server over HTTP (streamable HTTP, JSON answers) with one harmless tool. It records what it saw, never the token. */
export async function startMcpServer({ token, name = 'manythreads' }) {
  const seen = {
    requests: [],
    authOk: 0,
    authBad: 0,
    authMissing: 0,
    calls: [],
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers.authorization;
      if (!auth) seen.authMissing++;
      else if (auth === `Bearer ${token}`) seen.authOk++;
      else seen.authBad++;
      let rpc = null;
      try {
        rpc = body ? JSON.parse(body) : null;
      } catch {
        // the process is already gone
      }
      seen.requests.push({
        method: req.method,
        rpc: rpc?.method ?? null,
        accept: req.headers.accept ?? null,
        ua: req.headers['user-agent'] ?? null,
      });
      if (req.method !== 'POST' || !rpc) {
        res.writeHead(405).end();
        return;
      }
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      const reply = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      if (rpc.id === undefined) return void res.writeHead(202).end();
      if (rpc.method === 'initialize')
        return reply({
          protocolVersion: rpc.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name, version: '0.0.1' },
        });
      if (rpc.method === 'tools/list')
        return reply({
          tools: [
            {
              name: 'mt_note',
              description: 'Saves a short note. Harmless: it only returns the word noted.',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          ],
        });
      if (rpc.method === 'tools/call') {
        seen.calls.push({
          name: rpc.params?.name,
          args: rpc.params?.arguments,
        });
        return reply({ content: [{ type: 'text', text: 'noted' }] });
      }
      if (rpc.method === 'ping') return reply({});
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32601, message: 'no such method' },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The text of every agent_message_chunk of a list of session/update notifications. */
export const textOf = (notes, sessionId) =>
  notes
    .filter((n) => n.method === 'session/update' && (!sessionId || n.params.sessionId === sessionId) && n.params.update?.sessionUpdate === 'agent_message_chunk')
    .map((n) => n.params.update.content?.text ?? '')
    .join('');

/** Counts of each sessionUpdate kind. */
export const kinds = (notes) => {
  const out = {};
  for (const n of notes) if (n.method === 'session/update') out[n.params.update?.sessionUpdate] = (out[n.params.update?.sessionUpdate] ?? 0) + 1;
  return out;
};
