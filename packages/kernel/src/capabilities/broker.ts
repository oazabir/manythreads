import type { Actor } from '../db/with-actor.ts';
import { createEventAuditSink, type AuditSink, type DenialRecord, type AuditEmitFn } from './audit.ts';
import type { GrantSource } from './grants.ts';
import { checkBotWritePath, isFilesMutation } from './path-guard.ts';
import { PERSON_SCOPE_PREFIX, type CapabilityRegistry } from './registry.ts';

/** Triggers whose runs may use `person:*` (guide §7). */
export const PERSON_SCOPE_TRIGGERS: ReadonlySet<string> = new Set(['conversation', 'mention']);

export interface AuthorizeContext {
  /** Repo-relative path for `files.*` calls. */
  path?: string;
  /** Second path (destination of `files.move`/copy-like calls); guarded like `path`. */
  paths?: readonly string[];
  /** What started the run; defaults to `actor.trigger`. */
  trigger?: string;
  /** Request-specific constraints; `scope: 'person:*'` asks for the asking person's connections. */
  constraints?: Record<string, unknown>;
}

export interface Decision {
  allowed: boolean;
  reason: string;
  /** From the grant: the call waits in the Approvals inbox (spec §7.3). */
  needsApproval: boolean;
}

export interface BrokerOptions {
  registry: CapabilityRegistry;
  grants: GrantSource;
  /** Receives every denial. Default: emit `kernel.capability.denied` through `emit`; else collected in memory. */
  audit?: AuditSink;
  emit?: AuditEmitFn;
}

export class CapabilityBroker {
  readonly registry: CapabilityRegistry;
  /** Denials seen by the fallback sink (only filled when neither `audit` nor `emit` was given). */
  readonly denials: DenialRecord[] = [];
  private readonly grants: GrantSource;
  private readonly audit: AuditSink;

  constructor(options: BrokerOptions) {
    this.registry = options.registry;
    this.grants = options.grants;
    this.audit =
      options.audit ??
      (options.emit ? createEventAuditSink(options.emit) : (denial) => void this.denials.push(denial));
  }

  /** Decide one request. Every denial is logged through the audit sink. */
  async authorize(actor: Actor, capability: string, context: AuthorizeContext = {}): Promise<Decision> {
    const decision = await this.decide(actor, capability, context);
    if (!decision.allowed) await this.log(actor, capability, context, decision.reason);
    return decision;
  }

  private async decide(actor: Actor, capability: string, context: AuthorizeContext): Promise<Decision> {
    const deny = (reason: string): Decision => ({ allowed: false, reason, needsApproval: false });
    const trigger = context.trigger ?? actor.trigger;
    const isPersonScope =
      capability.startsWith(PERSON_SCOPE_PREFIX) ||
      (typeof context.constraints?.['scope'] === 'string' &&
        context.constraints['scope'].startsWith(PERSON_SCOPE_PREFIX));

    // `person:*` is a scope token, not a registered capability.
    const registered = this.registry.get(capability);
    if (!capability.startsWith(PERSON_SCOPE_PREFIX) && !registered) {
      return deny(`unknown capability "${capability}"`);
    }

    if (actor.kind === 'system') return { allowed: true, reason: 'system actor', needsApproval: false };
    if (actor.kind === 'person') {
      // Persons are checked against the ACL by the owning plugin (phase 2); the broker only knows the name.
      return { allowed: true, reason: 'person actor: ACL applies at the resource', needsApproval: false };
    }

    // From here on: bot actor.
    if (isFilesMutation(capability)) {
      const paths = [...(context.path !== undefined ? [context.path] : []), ...(context.paths ?? [])];
      if (paths.length === 0) return deny(`"${capability}" needs a path to be authorized`);
      for (const path of paths) {
        const verdict = checkBotWritePath(path);
        if (!verdict.allowed) return deny(verdict.reason);
      }
    }

    if (isPersonScope && !(trigger !== undefined && PERSON_SCOPE_TRIGGERS.has(trigger))) {
      return deny(
        `person:* scopes are only available to conversation and mention runs (trigger: ${trigger ?? 'none'})`,
      );
    }

    if (registered?.destructive) {
      return deny(`"${capability}" is destructive and can never be granted to a bot`);
    }

    const grant =
      (await this.grants.find(actor.id, capability)) ??
      (isPersonScope && !capability.startsWith(PERSON_SCOPE_PREFIX)
        ? await this.grants.find(actor.id, `${PERSON_SCOPE_PREFIX}*`)
        : undefined);
    if (!grant) return deny(`no grant for "${capability}" in the actor's allowlist`);
    return { allowed: true, reason: 'granted', needsApproval: grant.needsApproval };
  }

  private async log(actor: Actor, capability: string, context: AuthorizeContext, reason: string): Promise<void> {
    const trigger = context.trigger ?? actor.trigger ?? null;
    try {
      await this.audit({
        workspaceId: actor.workspaceId,
        actorId: actor.id,
        actorKind: actor.kind,
        runId: actor.runId ?? null,
        capability,
        reason,
        path: context.path ?? context.paths?.[0] ?? null,
        trigger,
      });
    } catch (err) {
      // A broken audit sink must never turn a deny into an allow, but it must not fail silently either.
      console.error('capability audit sink failed', err);
    }
  }
}
