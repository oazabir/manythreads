import type { DocumentAccess } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { everyoneMayRead, type TeamMemberAddress } from '../src/access-rule.ts';

// Decision D14 (PLAN Bundle D, P16-08): a document goes into a TEAM base only when everyone on the team may open it at the service. Pure function, so every shape of answer is tried here.

const access = (over: Partial<DocumentAccess> = {}): DocumentAccess => ({ anyone: false, domains: [], users: [], groups: false, ...over });
const person = (email: string, over: Partial<TeamMemberAddress> = {}): TeamMemberAddress => ({ email, verified: true, ...over });
const team: TeamMemberAddress[] = [person('omar@kahf.example'), person('nadia@kahf.example'), person('rafi@kahf.example'), person('priya@kahf.example')];

describe('everyoneMayRead', () => {
  it('a public link is everyone, whatever else is said and however the team looks', () => {
    expect(everyoneMayRead(access({ anyone: true }), team)).toBe(true);
    expect(everyoneMayRead(access({ anyone: true }), [])).toBe(true);
    expect(everyoneMayRead(access({ anyone: true, groups: true }), team)).toBe(true);
    expect(everyoneMayRead(access({ anyone: true }), [person('x@y.z', { verified: false })])).toBe(true);
  });

  it('shared with a domain: everyone at that domain is covered, and only exactly that domain', () => {
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), team)).toBe(true);
    expect(everyoneMayRead(access({ domains: ['other.example'] }), team)).toBe(false);
    // a subdomain is another domain, and so is a longer name that ends the same way
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), [person('a@mail.kahf.example')])).toBe(false);
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), [person('a@notkahf.example')])).toBe(false);
    expect(everyoneMayRead(access({ domains: ['example'] }), [person('a@kahf.example')])).toBe(false);
  });

  it('shared with people one by one: every member must be listed', () => {
    const all = ['omar@kahf.example', 'nadia@kahf.example', 'rafi@kahf.example', 'priya@kahf.example'];
    expect(everyoneMayRead(access({ users: all }), team)).toBe(true);
    // the Drive file shared with only Nadia and Rafi (PLAN criterion 6)
    expect(everyoneMayRead(access({ users: ['nadia@kahf.example', 'rafi@kahf.example'] }), team)).toBe(false);
    // one member missing
    expect(everyoneMayRead(access({ users: all.slice(0, 3) }), team)).toBe(false);
    // more people than the team is fine
    expect(everyoneMayRead(access({ users: [...all, 'tariq@kahf.example'] }), team)).toBe(true);
  });

  it('a domain and a list of people can cover the team together', () => {
    const mixed = [person('a@kahf.example'), person('b@elsewhere.example')];
    expect(everyoneMayRead(access({ domains: ['kahf.example'], users: ['b@elsewhere.example'] }), mixed)).toBe(true);
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), mixed)).toBe(false);
    expect(everyoneMayRead(access({ users: ['b@elsewhere.example'] }), mixed)).toBe(false);
  });

  it('a group share, or an answer that could not be read, is not everyone', () => {
    expect(everyoneMayRead(access({ groups: true }), team)).toBe(false);
    // even when the same answer also lists everyone: the group's members are not known, so the answer is not trusted
    expect(everyoneMayRead(access({ groups: true, domains: ['kahf.example'] }), team)).toBe(false);
    expect(everyoneMayRead(access({ groups: true, users: team.map((m) => m.email) }), team)).toBe(false);
  });

  it('an empty answer is nobody, and a team with nobody to check proves nothing', () => {
    expect(everyoneMayRead(access(), team)).toBe(false);
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), [])).toBe(false);
    expect(everyoneMayRead(access({ users: ['a@b.c'] }), [])).toBe(false);
    expect(everyoneMayRead(access({ domains: ['', '  '], users: [''] }), team)).toBe(false);
  });

  it('bots and guests are not people of the team for this rule', () => {
    const withBots: TeamMemberAddress[] = [...team, { email: 'bot@bots.example', verified: false, kind: 'bot' }, { email: '', verified: false, kind: 'bot' }];
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), withBots)).toBe(true);
    const withGuest: TeamMemberAddress[] = [...team, { email: 'lena@guest.example', verified: true, kind: 'guest' }];
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), withGuest)).toBe(true);
    // a team of bots alone proves nothing
    expect(everyoneMayRead(access({ domains: ['bots.example'] }), [{ email: 'bot@bots.example', verified: true, kind: 'bot' }])).toBe(false);
  });

  it('upper-case addresses and domains match', () => {
    expect(everyoneMayRead(access({ domains: ['KAHF.Example'] }), team)).toBe(true);
    expect(everyoneMayRead(access({ users: ['NADIA@KAHF.EXAMPLE'] }), [person('Nadia@Kahf.Example')])).toBe(true);
    expect(everyoneMayRead(access({ users: ['  nadia@kahf.example '] }), [person(' NADIA@kahf.example')])).toBe(true);
  });

  it('an address the workspace has not verified covers nobody', () => {
    const unverified = [...team.slice(0, 3), person('priya@kahf.example', { verified: false })];
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), unverified)).toBe(false);
    expect(everyoneMayRead(access({ users: unverified.map((m) => m.email) }), unverified)).toBe(false);
    // ... unless the document is public
    expect(everyoneMayRead(access({ anyone: true }), unverified)).toBe(true);
  });

  it('a person with several verified addresses is covered by any one of them', () => {
    const tariq = person('tariq@kahf.example', { others: ['tariq@kahf.co'] });
    expect(everyoneMayRead(access({ domains: ['kahf.co'] }), [tariq])).toBe(true);
    expect(everyoneMayRead(access({ users: ['tariq@kahf.co'] }), [tariq])).toBe(true);
    expect(everyoneMayRead(access({ domains: ['kahf.net'] }), [tariq])).toBe(false);
  });

  it('a member without a usable address is not covered', () => {
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), [...team, person('')])).toBe(false);
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), [...team, person('no-at-sign')])).toBe(false);
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), [...team, person('trailing@')])).toBe(false);
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), [...team, person('@kahf.example')])).toBe(false);
  });

  it('a domain is read from the last @, so an address cannot borrow a domain', () => {
    expect(everyoneMayRead(access({ domains: ['kahf.example'] }), [person('a@kahf.example@evil.example')])).toBe(false);
    expect(everyoneMayRead(access({ domains: ['evil.example'] }), [person('a@kahf.example@evil.example')])).toBe(true);
  });
});
