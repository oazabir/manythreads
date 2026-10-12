/**
 * Every server of a Playwright run shares ONE Postgres (100 connections, 3 reserved): up to four per-spec stacks next to the three
 * shared servers, each with the default pools of 10 + 10, peaked at 98 connections and the 98th client got "remaining connection slots are
 * reserved" (a 500 in a `beforeAll`, at 0 ms, in whichever spec started a stack at that moment). A stack needs a handful.
 */
export const E2E_POOL_ENV = { MANYTHREADS_APP_POOL_MAX: '5', MANYTHREADS_SYSTEM_POOL_MAX: '5' } as const;
