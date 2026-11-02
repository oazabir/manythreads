import { MODEL_PROVIDER_ADDRESS, type GatewayProfileSpec } from '@manythreads/sdk';
import type { K8sObject } from './k8s.ts';

// Every model call of a Hermes pod goes through the platform's model gateway, with the bot's own virtual key. The pod never holds a model provider's key or
// address. This file is the last guard before a pod's objects are written: a profile that names a provider is left out (with a plain reason), and a
// Deployment or Secret that carries one stops the write. Pure, so a test can run it against the objects the builders make.

/** The only variables a profile's secrets define (the names the profile files refer to). */
export const ALLOWED_PROFILE_SECRETS = ['MCP_TOKEN', 'LLM_KEY', 'API_SERVER_KEY'] as const;

/** The environment variable names the pod itself is allowed to define that look like a key: the pod's own gateway key and the platform's. */
const ALLOWED_ENV = new Set(['API_SERVER_KEY', 'MANYTHREADS_LLM_KEY', 'MANYTHREADS_MCP_TOKEN']);

/** Names that carry a model provider's key or address (OPENAI_API_KEY, ANTHROPIC_BASE_URL, OPENROUTER_API_KEY, GEMINI_API_KEY, ...). */
const PROVIDER_ENV =
  /^(?:OPENAI|ANTHROPIC|OPENROUTER|GEMINI|GOOGLE_API|AZURE_OPENAI|MISTRAL|GROQ|DEEPSEEK|XAI|COHERE|TOGETHER|PERPLEXITY|FIREWORKS|HF|HUGGINGFACE|AWS_BEDROCK|VERTEX|LLM)_[A-Z0-9_]*$|^[A-Z0-9_]*(?:_API_KEY|_API_BASE|_BASE_URL|_API_URL)$/;

/** Addresses of the well-known model providers (one list with the profile renderer's). A profile or Secret that names one is pointing the pod at a provider, not at the gateway. */
const PROVIDER_HOSTS = MODEL_PROVIDER_ADDRESS;

/** `${NAME}` references and `NAME=` assignments in a profile file: the variable names it uses. Linear: one pass of a bounded pattern. */
const ENV_USES = /\$\{([A-Z][A-Z0-9_]{1,63})\}|^([A-Z][A-Z0-9_]{1,63})=/gm;

export const isProviderEnvName = (name: string): boolean => !ALLOWED_ENV.has(name) && PROVIDER_ENV.test(name);

/** Why a profile may not be written into a pod, in a plain sentence; null when it is clean. */
export function profileViolation(spec: GatewayProfileSpec): string | null {
  for (const key of Object.keys(spec.secrets)) {
    if (!(ALLOWED_PROFILE_SECRETS as readonly string[]).includes(key)) {
      return `The profile of ${spec.profile} defines a secret named ${key}. A Hermes pod only holds its bot's gateway key; a model provider's key never goes in a pod.`;
    }
  }
  for (const [file, text] of Object.entries(spec.files)) {
    if (PROVIDER_HOSTS.test(text)) {
      return `The ${file} of ${spec.profile} points at a model provider's address. Hermes pods reach models only through the manythreads model gateway.`;
    }
    for (const match of text.matchAll(ENV_USES)) {
      const name = (match[1] ?? match[2]) as string;
      if (isProviderEnvName(name)) {
        return `The ${file} of ${spec.profile} uses ${name}. A model provider's key never goes in a Hermes pod; its bot reaches models through the manythreads model gateway.`;
      }
    }
  }
  return null;
}

/** Every string of an object, to look for a provider's address in (keys and values, any depth; bounded by the object's own size). */
function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    yield k;
    yield* strings(v);
  }
}

/** Throws a plain error when an object about to be written holds a model provider's key name or address. The backstop behind {@link profileViolation}. */
export function assertGatewayOnly(objects: readonly K8sObject[]): void {
  for (const obj of objects) {
    const where = `${obj.kind} ${obj.metadata.name}`;
    const pod = (obj as { spec?: { template?: { spec?: { containers?: unknown[]; initContainers?: unknown[] } } } }).spec?.template?.spec;
    for (const c of [...(pod?.containers ?? []), ...(pod?.initContainers ?? [])] as Array<{ env?: Array<{ name: string }>; envFrom?: unknown[] }>) {
      if ((c.envFrom?.length ?? 0) > 0) throw new Error(`${where} reads whole Secrets or ConfigMaps into the environment; a Hermes pod defines each variable by name so no provider key can slip in.`);
      for (const e of c.env ?? []) {
        if (isProviderEnvName(e.name)) throw new Error(`${where} defines ${e.name}. A model provider's key never goes in a Hermes pod; models are reached through the manythreads model gateway.`);
      }
    }
    for (const s of strings((obj as { data?: unknown }).data)) {
      if (PROVIDER_HOSTS.test(s)) throw new Error(`${where} points at a model provider's address. Hermes pods reach models only through the manythreads model gateway.`);
    }
    for (const s of strings((obj as { stringData?: unknown }).stringData)) {
      if (PROVIDER_HOSTS.test(s)) throw new Error(`${where} points at a model provider's address. Hermes pods reach models only through the manythreads model gateway.`);
    }
  }
}
