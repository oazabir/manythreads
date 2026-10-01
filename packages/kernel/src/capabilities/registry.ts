import { CapabilityName } from '@manythreads/shared';

export class CapabilityError extends Error {
  override readonly name = 'CapabilityError';
}

export interface RegisteredCapability {
  name: string;
  destructive: boolean;
  /** Plugin that declared it (or `kernel`). */
  plugin: string;
}

/** Names of capabilities with their destructive tag, filled from plugin manifests. */
export class CapabilityRegistry {
  private readonly byName = new Map<string, RegisteredCapability>();

  register(capability: RegisteredCapability): void {
    const parsed = CapabilityName.safeParse(capability.name);
    if (!parsed.success) {
      throw new CapabilityError(`Invalid capability name "${capability.name}": ${parsed.error.issues[0]?.message}`);
    }
    const existing = this.byName.get(capability.name);
    if (existing) {
      throw new CapabilityError(
        `Capability "${capability.name}" is already registered by plugin "${existing.plugin}" (plugin "${capability.plugin}" tried to register it)`,
      );
    }
    this.byName.set(capability.name, { ...capability });
  }

  get(name: string): RegisteredCapability | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  list(): RegisteredCapability[] {
    return [...this.byName.values()];
  }

  /**
   * Grant-time rule (guide §7): a destructive capability never enters an allowlist. Throws, naming every
   * offender; unknown names are rejected too. `person:*` scope tokens are not capabilities and pass through.
   */
  assertGrantable(capabilities: readonly string[]): void {
    const problems: string[] = [];
    for (const name of capabilities) {
      if (name.startsWith(PERSON_SCOPE_PREFIX)) continue;
      const known = this.byName.get(name);
      if (!known) problems.push(`"${name}" is not a registered capability`);
      else if (known.destructive) problems.push(`"${name}" is destructive and can never be granted`);
    }
    if (problems.length > 0) throw new CapabilityError(`Allowlist rejected: ${problems.join('; ')}`);
  }
}

/** `person:*` means "the asking person's own connections" (spec §7.2). */
export const PERSON_SCOPE_PREFIX = 'person:';
