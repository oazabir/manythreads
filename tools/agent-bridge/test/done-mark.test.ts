import { describe, expect, it } from 'vitest';
import { CONTINUE_DONE, withoutDoneMark } from '../src/acp/session.ts';

describe('withoutDoneMark', () => {
  it('removes one closing mark and keeps the words before it', () => {
    expect(withoutDoneMark(`Opened PR #19.\n${CONTINUE_DONE}`)).toBe('Opened PR #19.');
    expect(withoutDoneMark(`Opened PR #19.\n${CONTINUE_DONE}.`)).toBe('Opened PR #19.');
  });
  it('removes the marks of several extra turns, also when the adapter joined them with nothing between', () => {
    expect(withoutDoneMark(`Team memory returned an error.${CONTINUE_DONE}${CONTINUE_DONE}`)).toBe('Team memory returned an error.');
    expect(withoutDoneMark(`Done.\n${CONTINUE_DONE}\n\n${CONTINUE_DONE}\n`)).toBe('Done.');
  });
  it('leaves an answer without the mark, and an answer that is only the mark becomes empty', () => {
    expect(withoutDoneMark('Handed off.')).toBe('Handed off.');
    expect(withoutDoneMark(`${CONTINUE_DONE}`)).toBe('');
  });
});
