import type { LlmAliasName, LlmProviderKind } from '../../entities/llm.ts';

/*
 * The model presets of the first-run wizard (PLAN Phase 27, P27-09): for each provider an admin is likely to have, the model each of the three working
 * aliases is bound to when they paste a key. One table, kept here so the wizard, its tests and the docs read the same names; the owner updates it per
 * release (docs/plans/onboarding-journey.md §10 q5). A "coding plan" is a subscription some vendors sell for coding tools: it is an OpenAI-compatible
 * address plus a key, so it goes in as a provider of that kind with the vendor's address filled in.
 */

/** The three aliases the wizard binds; the others (local, embed, vision, image, transcribe) stay on the model settings page. */
export const PRESET_ALIASES = ['smart', 'fast', 'code'] as const satisfies readonly LlmAliasName[];
export type PresetAlias = (typeof PRESET_ALIASES)[number];

export interface LlmPreset {
  id: string;
  /** What the admin reads on the card. */
  label: string;
  /** One sentence: what the key is and where it comes from, in plain words. */
  hint: string;
  /** `plan`: a coding-plan subscription (address and key); `key`: an ordinary API key; `local`: a model server on the company's own machine. */
  type: 'key' | 'plan' | 'local';
  kind: LlmProviderKind;
  /** The provider's address; null for a provider whose own address the gateway knows. For `local` the admin fills it in. */
  apiBase: string | null;
  /** The admin may (or, for `local` and `plan`, must be able to) change the address. */
  editableBase: boolean;
  /** The model each alias is bound to. */
  models: Record<PresetAlias, string>;
  /** Shown beside the key field. */
  keyLabel: string;
}

export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    hint: 'An API key from console.anthropic.com. It is billed by use.',
    type: 'key',
    kind: 'anthropic',
    apiBase: null,
    editableBase: false,
    models: { smart: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5', code: 'claude-sonnet-4-5' },
    keyLabel: 'Anthropic API key',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'An API key from platform.openai.com. It is billed by use.',
    type: 'key',
    kind: 'openai',
    apiBase: null,
    editableBase: false,
    models: { smart: 'gpt-5', fast: 'gpt-5-mini', code: 'gpt-5' },
    keyLabel: 'OpenAI API key',
  },
  {
    id: 'google',
    label: 'Google (Gemini)',
    hint: 'An API key from Google AI Studio.',
    type: 'key',
    kind: 'google',
    apiBase: null,
    editableBase: false,
    models: { smart: 'gemini-2.5-pro', fast: 'gemini-2.5-flash', code: 'gemini-2.5-pro' },
    keyLabel: 'Google API key',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'One key for many vendors, from openrouter.ai.',
    type: 'key',
    kind: 'openai_compatible',
    apiBase: 'https://openrouter.ai/api/v1',
    editableBase: false,
    models: { smart: 'anthropic/claude-sonnet-4.5', fast: 'anthropic/claude-haiku-4.5', code: 'anthropic/claude-sonnet-4.5' },
    keyLabel: 'OpenRouter API key',
  },
  {
    id: 'glm-plan',
    label: 'GLM coding plan (Z.ai)',
    hint: 'A coding-plan subscription: its address and its key, from your Z.ai account.',
    type: 'plan',
    kind: 'openai_compatible',
    apiBase: 'https://api.z.ai/api/coding/paas/v4',
    editableBase: true,
    models: { smart: 'glm-4.6', fast: 'glm-4.5-air', code: 'glm-4.6' },
    keyLabel: 'Plan key',
  },
  {
    id: 'kimi-plan',
    label: 'Kimi coding plan (Moonshot)',
    hint: 'A coding-plan subscription: its address and its key, from your Kimi account.',
    type: 'plan',
    kind: 'openai_compatible',
    apiBase: 'https://api.kimi.com/coding/v1',
    editableBase: true,
    models: { smart: 'kimi-for-coding', fast: 'kimi-for-coding', code: 'kimi-for-coding' },
    keyLabel: 'Plan key',
  },
  {
    id: 'minimax-plan',
    label: 'MiniMax coding plan',
    hint: 'A coding-plan subscription: its address and its key, from your MiniMax account.',
    type: 'plan',
    kind: 'openai_compatible',
    apiBase: 'https://api.minimax.io/v1',
    editableBase: true,
    models: { smart: 'MiniMax-M2', fast: 'MiniMax-M2', code: 'MiniMax-M2' },
    keyLabel: 'Plan key',
  },
  {
    id: 'other-plan',
    label: 'Another OpenAI-compatible address',
    hint: 'Any address that speaks the OpenAI protocol, with the key it gave you, and the name of the model to use.',
    type: 'plan',
    kind: 'openai_compatible',
    apiBase: null,
    editableBase: true,
    models: { smart: '', fast: '', code: '' },
    keyLabel: 'Key',
  },
  {
    id: 'ollama',
    label: 'A model on your own machine (Ollama)',
    hint: 'Runs inside your network, no key. Give its address; nothing leaves your machines.',
    type: 'local',
    kind: 'ollama',
    apiBase: null,
    editableBase: true,
    models: { smart: 'llama3.1', fast: 'llama3.1', code: 'llama3.1' },
    keyLabel: 'Key (leave empty)',
  },
];

export const presetById = (id: string): LlmPreset | undefined => LLM_PRESETS.find((p) => p.id === id);

/** The default monthly spend cap the wizard offers, in US dollars (the cap used for the Phase 26 proofs). */
export const DEFAULT_MONTHLY_CAP_USD = 25;
