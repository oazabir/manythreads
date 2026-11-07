import { describe, expect, it } from 'vitest';
import { signInMethodSentence } from '../src/screens/account/signInMethod';

// P21-F: the Security page showed "Email and password ok"; the chip is the name with a check mark, and its spoken name says what it means.
describe('signInMethodSentence', () => {
  it('says the method is set up, with no "ok"', () => {
    expect(signInMethodSentence('Email and password')).toBe('Email and password is set up');
    expect(signInMethodSentence('Email and password')).not.toMatch(/\bok\b/i);
  });
});
