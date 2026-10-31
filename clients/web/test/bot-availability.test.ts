import { describe, expect, it } from 'vitest';
import type { BotSummary, HermesConnection } from '@manythreads/shared';
import { botAvailability } from '../src/screens/bots/availability';

type B = Pick<BotSummary, 'status' | 'runtime' | 'placement'>;
const bot = (over: Partial<B> = {}): B => ({ status: 'active', runtime: 'hermes', placement: null, ...over });
const onGateway = (connection: string): B => bot({ placement: { gateway: { connection } } as B['placement'] });
const conn = (name: string, status: HermesConnection['status']) => ({ name, status }) as HermesConnection;

describe('what the roster says about a bot', () => {
  it('keeps the failed and switched-off states', () => {
    expect(botAvailability(bot({ status: 'invalid' }), null)).toMatchObject({ tone: 'bad', label: 'needs a fix' });
    expect(botAvailability(bot({ status: 'disabled' }), null)).toMatchObject({ tone: 'off', label: 'off' });
  });
  it('calls a rules bot ready, since it runs inside the server', () => {
    expect(botAvailability(bot({ runtime: 'rules' }), null)).toMatchObject({ tone: 'ready', label: 'ready' });
  });
  it('never says ready for a Hermes bot it cannot check', () => {
    const noPlacement = botAvailability(bot(), []);
    expect(noPlacement).toMatchObject({ tone: 'unchecked', label: 'active' });
    expect(noPlacement.hint).toMatch(/server itself/);
    expect(botAvailability(bot({ placement: { runner: 'build-01' } as B['placement'] }), []).hint).toMatch(/runner/);
    expect(botAvailability(onGateway('managed'), null)).toMatchObject({ tone: 'unchecked', label: 'active' });
  });
  it('follows the connection the bot is placed on', () => {
    expect(botAvailability(onGateway('managed'), [])).toMatchObject({ tone: 'warn', label: 'agent not set up' });
    expect(botAvailability(onGateway('managed'), [conn('other', 'ok')])).toMatchObject({ tone: 'warn' });
    expect(botAvailability(onGateway('managed'), [conn('managed', 'ok')])).toMatchObject({ tone: 'ready', label: 'ready' });
    expect(botAvailability(onGateway('managed'), [conn('managed', 'error')])).toMatchObject({ tone: 'bad', label: 'agent not working' });
    expect(botAvailability(onGateway('managed'), [conn('managed', 'unknown')])).toMatchObject({ tone: 'unchecked', label: 'active' });
  });
});
