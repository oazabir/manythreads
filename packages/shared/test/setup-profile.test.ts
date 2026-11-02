import { describe, expect, it } from 'vitest';
import { SETUP_TOOLS, parseSetupProfile } from '../src/bot-md/setup-profile.ts';

// P7-02: the helper's profile file. It names the model aliases and the tools; the tools are a fixed list it can only shorten.

const file = (front: string, body = 'You help a person describe a bot.\n') => `---\n${front}---\n\n${body}`;
const GOOD = 'schema: 1\nname: Bot setup helper\nrole: Helps set up a bot\nmodel:\n  aliases: [smart, fast]\ntools: [describe_self, knowledge_search, ask_clarification, propose_config]\nlimits:\n  steps: 8\n';

describe('the setup profile', () => {
  it('reads a good file: the profile and the prompt', () => {
    const r = parseSetupProfile(file(GOOD));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile.tools).toEqual([...SETUP_TOOLS]);
      expect(r.profile.limits?.steps).toBe(8);
      expect(r.prompt).toBe('You help a person describe a bot.');
    }
  });

  it('may leave a tool out but never add one', () => {
    expect(parseSetupProfile(file(GOOD.replace('tools: [describe_self, knowledge_search, ask_clarification, propose_config]', 'tools: [describe_self, propose_config]'))).ok).toBe(true);
    const more = parseSetupProfile(file(GOOD.replace('propose_config]', 'propose_config, shell]')));
    expect(more.ok).toBe(false);
  });

  it('refuses a tool listed twice, an unknown key, no prompt and no frontmatter', () => {
    expect(parseSetupProfile(file(GOOD.replace('describe_self, knowledge_search', 'describe_self, describe_self'))).ok).toBe(false);
    expect(parseSetupProfile(file(`${GOOD}triggers: []\n`)).ok).toBe(false);
    expect(parseSetupProfile(file(GOOD, '   \n'))).toEqual({ ok: false, message: 'the profile has no prompt' });
    const none = parseSetupProfile('just text');
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.message).not.toContain('BOT.md');
  });

  it('bounds the steps', () => {
    expect(parseSetupProfile(file(GOOD.replace('steps: 8', 'steps: 99'))).ok).toBe(false);
  });
});
