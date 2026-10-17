// The HTTP kit lives in the SDK (packages/sdk/src/http.ts); `routes.ts` imports it from there directly.
// This module keeps the plugin's import path stable for anything still importing `./http.ts`.
export { conflict, forbidden, invalid, json, notFound, requireTeam, route } from '@manythreads/sdk';
export type { TeamRow } from '@manythreads/sdk';
