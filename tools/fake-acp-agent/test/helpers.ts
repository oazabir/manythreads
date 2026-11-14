import { client as createClient, methods, type ClientApp, type ClientContext, type SessionUpdate } from '@agentclientprotocol/sdk';
import { createFakeAcpAgent, type FakeAcpAgent } from '../src/agent.ts';
import type { FakeScript } from '../src/script.ts';

export interface Harness {
  fake: FakeAcpAgent;
  updates: Array<Record<string, unknown>>;
  /** Frames other than session/update that the agent sent to the client: requests and notifications, by method. */
  inbound: Array<{ method: string; params: unknown }>;
  permissions: Array<{ toolCall: Record<string, unknown>; options: Array<{ optionId: string; kind: string }> }>;
  run<T>(op: (agent: ClientContext) => Promise<T>): Promise<T>;
}

export interface HarnessOptions {
  /** What the client answers to a permission request: an option kind, `cancelled`, or `hang` (never). */
  permission?: 'allow_once' | 'reject_once' | 'cancelled' | 'hang';
  /** What the client answers to an elicitation: accept, cancel, or `hang`. */
  elicitation?: 'accept' | 'cancel';
}

/** A client app joined in-process to a fake agent: the SDK's own client talks to our agent, so the tests prove the wire both ways. */
export function harness(script: FakeScript, options: HarnessOptions = {}): Harness {
  const fake = createFakeAcpAgent(script);
  const updates: Harness['updates'] = [];
  const inbound: Harness['inbound'] = [];
  const permissions: Harness['permissions'] = [];
  const app: ClientApp = createClient({ name: 'test-client' })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update as unknown as Record<string, unknown>);
    })
    .onNotification('*', ({ method, params }) => {
      inbound.push({ method, params });
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      permissions.push({ toolCall: params.toolCall as unknown as Record<string, unknown>, options: params.options });
      if (options.permission === 'hang') return new Promise<never>(() => undefined);
      if (options.permission === 'cancelled') return { outcome: { outcome: 'cancelled' } };
      const wanted = options.permission ?? 'allow_once';
      const option = params.options.find((o) => o.kind === wanted);
      return { outcome: { outcome: 'selected', optionId: option?.optionId ?? 'none' } };
    })
    .onRequest(methods.client.elicitation.create, async ({ params }) => {
      inbound.push({ method: 'elicitation/create', params });
      return { action: options.elicitation ?? 'accept' };
    });
  return {
    fake,
    updates,
    inbound,
    permissions,
    run: (op) => app.connectWith(fake.app, (ctx) => op(ctx)),
  };
}

export const OURS = { auth: { terminal: true, _meta: { gateway: true } }, elicitation: { url: {} } };

export function kinds(updates: Array<Record<string, unknown>>): string[] {
  return updates.map((u) => String(u.sessionUpdate));
}

export function texts(updates: Array<Record<string, unknown>>): string {
  return updates
    .filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map((u) => (u.content as { text: string }).text)
    .join('');
}

export type Update = SessionUpdate & Record<string, unknown>;

/** `initialize` with our capabilities, then `session/new`: what every run of the bridge starts with. */
export async function start(agent: ClientContext, cwd = '/work/demo'): Promise<string> {
  await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
  const session = await agent.request('session/new', { cwd, mcpServers: [] });
  return session.sessionId;
}

/** Polls until the condition holds. */
export async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
