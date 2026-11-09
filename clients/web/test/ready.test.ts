import { afterEach, describe, expect, it, vi } from 'vitest';
import { READY_QUIET_MS, createReadyGate, trackRequest } from '../src/api/ready';

function setup(over: { fonts?: boolean; busy?: boolean } = {}) {
  let t = 1_000;
  const state = { fonts: over.fonts ?? true, busy: over.busy ?? false };
  const published: boolean[] = [];
  const gate = createReadyGate({ now: () => t, fontsReady: () => state.fonts, hasBusy: () => state.busy, publish: (r) => published.push(r) });
  return { gate, state, published, advance: (ms: number) => void (t += ms) };
}

describe('data-ready gate (E31)', () => {
  it('is not ready before the quiet time has passed, then is', () => {
    const { gate, advance } = setup();
    expect(gate.check()).toBe(false);
    advance(READY_QUIET_MS - 1);
    expect(gate.check()).toBe(false);
    advance(1);
    expect(gate.check()).toBe(true);
  });

  it('goes false the moment a request starts and stays false while it is in flight, however long', () => {
    const { gate, advance, published } = setup();
    advance(READY_QUIET_MS);
    expect(gate.check()).toBe(true);
    gate.begin();
    expect(published.at(-1)).toBe(false);
    advance(10_000);
    expect(gate.check()).toBe(false);
    gate.end();
    // the quiet time counts from the END of the last request
    expect(gate.check()).toBe(false);
    advance(READY_QUIET_MS);
    expect(gate.check()).toBe(true);
  });

  it('counts overlapping requests: ready only after the last one ends', () => {
    const { gate, advance } = setup();
    gate.begin();
    gate.begin();
    gate.end();
    advance(READY_QUIET_MS * 2);
    expect(gate.check()).toBe(false);
    gate.end();
    advance(READY_QUIET_MS);
    expect(gate.check()).toBe(true);
    expect(gate.inFlight).toBe(0);
  });

  it('never goes below zero when end is called without begin', () => {
    const { gate } = setup();
    gate.end();
    expect(gate.inFlight).toBe(0);
  });

  it('is not ready while fonts load or while an aria-busy element is on screen', () => {
    const { gate, state, advance } = setup({ fonts: false });
    advance(READY_QUIET_MS * 3);
    expect(gate.check()).toBe(false);
    state.fonts = true;
    state.busy = true;
    expect(gate.check()).toBe(false);
    state.busy = false;
    expect(gate.check()).toBe(true);
  });

  it('publishes only changes', () => {
    const { gate, advance, published } = setup();
    advance(READY_QUIET_MS);
    gate.check();
    gate.check();
    gate.check();
    expect(published).toEqual([true]);
  });
});

describe('trackRequest outside a browser', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('just runs the request and passes its answer and its failure through', async () => {
    await expect(trackRequest(async () => 7)).resolves.toBe(7);
    await expect(trackRequest(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});
