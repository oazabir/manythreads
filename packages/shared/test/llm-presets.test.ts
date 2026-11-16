import { describe, expect, it } from 'vitest';
import { DEFAULT_MONTHLY_CAP_USD, LLM_PRESETS, PRESET_ALIASES, LlmAliasName, LlmProviderKind, presetById } from '../src/index.ts';

// The first-run wizard binds smart, fast and code from one table; a wrong row is a wizard that connects and then fails its test.
describe('the model presets of the setup wizard', () => {
  it('has a unique id per preset and a model for each of the three aliases', () => {
    const ids = LLM_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of LLM_PRESETS) {
      // the one preset for "any OpenAI-compatible address" has no model of its own: the admin names it in the wizard
      for (const alias of PRESET_ALIASES) {
        if (p.id === 'other-plan') expect(p.models[alias]).toBe('');
        else expect(p.models[alias], `${p.id}.${alias}`).toMatch(/\S/);
      }
      expect(LlmProviderKind.safeParse(p.kind).success, p.id).toBe(true);
    }
  });

  it('binds only aliases the gateway knows', () => {
    for (const a of PRESET_ALIASES) expect(LlmAliasName.safeParse(a).success).toBe(true);
  });

  it('gives a coding plan an address, and a local model one to fill in', () => {
    for (const p of LLM_PRESETS.filter((x) => x.type === 'plan' && x.id !== 'other-plan')) {
      expect(p.apiBase ?? '', p.id).toMatch(/^https:\/\//);
    }
    expect(presetById('other-plan')?.editableBase).toBe(true);
    expect(LLM_PRESETS.some((p) => p.type === 'plan')).toBe(true);
    for (const p of LLM_PRESETS.filter((x) => x.type === 'local')) expect(p.editableBase, p.id).toBe(true);
  });

  it('offers a key for each provider the owner named, and finds a preset by id', () => {
    for (const id of ['anthropic', 'openai', 'google', 'openrouter']) expect(presetById(id)?.type, id).toBe('key');
    expect(presetById('nope')).toBeUndefined();
  });

  it('has a plain monthly spending limit', () => {
    expect(DEFAULT_MONTHLY_CAP_USD).toBeGreaterThan(0);
  });
});
