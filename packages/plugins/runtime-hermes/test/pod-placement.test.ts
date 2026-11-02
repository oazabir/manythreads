import { describe, expect, it } from 'vitest';
import { podPlacementParamsOf, podPlacementWhere } from '../src/profiles.ts';

// Which bots live on a team's own pod is one rule (`podPlacementWhere`), used by the profile list, the pods controller's list of teams and the re-enable route.
// The SQL itself is tested against a database in gateway-run.test.ts; here the fragment's shape and the three parameters it takes.

describe('podPlacementWhere', () => {
  it('numbers its three parameters from the first one it is given', () => {
    const sql = podPlacementWhere(2);
    expect(sql).toContain('$2');
    expect(sql).toContain('$3::text[]');
    expect(sql).toContain('$4::boolean');
    expect(sql).not.toContain('$1');
    expect(sql).not.toContain('$5');
    expect(podPlacementWhere(3)).toContain('$5::boolean');
  });

  it('takes the managed connection, a runs_on on a pod runner, and a bot with no place of its own only while the default is a pod', () => {
    const sql = podPlacementWhere(1);
    expect(sql).toContain("placement -> 'gateway' ->> 'connection' = $1");
    expect(sql).toContain("placement ->> 'runs_on' = ANY($2::text[])");
    // the default applies to Hermes bots only, and only to those with none of the four places (the ?| operator, on a placement that may be null)
    expect(sql).toContain("runtime = 'hermes'");
    expect(sql).toContain("coalesce(placement, '{}'::jsonb) ?| ARRAY['runs_on', 'gateway', 'node', 'runner']");
  });
});

describe('podPlacementParamsOf', () => {
  it('is the managed name, the pod runners the team may use, and whether the default is one of them', () => {
    expect(podPlacementParamsOf(undefined)).toEqual(['managed', [], false]);
    expect(podPlacementParamsOf({ defaultRunner: null, podRunners: ['tp'] })).toEqual(['managed', ['tp'], false]);
    expect(podPlacementParamsOf({ defaultRunner: 'tp', podRunners: ['tp'] })).toEqual(['managed', ['tp'], true]);
    // a default that is a gateway runner (not in the pod list) puts no bot on the pod
    expect(podPlacementParamsOf({ defaultRunner: 'house', podRunners: ['tp'] })).toEqual(['managed', ['tp'], false]);
  });
});
