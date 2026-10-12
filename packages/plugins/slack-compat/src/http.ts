import { HttpError } from '@manythreads/sdk';

// The HTTP kit lives in the SDK (packages/sdk/src/http.ts); this module keeps the plugin's import path stable.
export { conflict, forbidden, invalid, json, notFound, route } from '@manythreads/sdk';

export const unauthenticated = (message = 'A valid pairing token is required'): HttpError => new HttpError(401, 'unauthenticated', message);
