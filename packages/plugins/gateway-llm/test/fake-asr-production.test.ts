import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerLlmProvider } from '../src/provider.ts';

// PLAN P15 §10: the speech-to-text stand-in (`MANYTHREADS_FAKE_ASR=1`) is for tests and must never run in production. transcribe.test.ts proves the check function; this proves
// the plugin really calls it when it registers, so a server started with the switch on in production does not come up (and the stand-in's "hear the words after FAKEASR" door
// cannot be reached on the live site).

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registering the LLM provider', () => {
  it('refuses to start with the stand-in transcriber on in production, before it touches anything of the server', () => {
    vi.stubEnv('MANYTHREADS_FAKE_ASR', '1');
    vi.stubEnv('NODE_ENV', 'production');
    // the check is the first statement: a context with nothing in it is enough, and would throw a different error if the check were removed or moved after use
    expect(() => registerLlmProvider({} as never)).toThrow(/MANYTHREADS_FAKE_ASR=1 is a test stand-in and is refused when NODE_ENV=production/);
  });

  it('does not refuse in production when the switch is off, and gets past the check when it is on outside production', () => {
    for (const [asr, env] of [['', 'production'], ['0', 'production'], ['1', 'test']] as const) {
      vi.stubEnv('MANYTHREADS_FAKE_ASR', asr);
      vi.stubEnv('NODE_ENV', env);
      // an empty context fails later, on the first thing the provider reads from it: what matters is that it is not the production refusal
      expect(() => registerLlmProvider({} as never), `${asr || 'unset'} in ${env}`).not.toThrow(/test stand-in/);
    }
  });
});
