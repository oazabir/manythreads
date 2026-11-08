import { HttpError } from '@manythreads/sdk';

// The stub every Bundle D route of this plugin answers with until the work package that owns it fills the handler in (docs/plugins/connections.md "Bundle D contracts").
// Nothing else in the callers changes when a package replaces a stub: the path, the schemas and the rate limit are the contract.
export const notBuilt = (): never => {
  throw new HttpError(501, 'internal', 'Not built yet');
};

/** What a connector door answers while its owner has not built it: nothing is connected, so a caller shows its plain "connect it first" path. */
export const NOT_BUILT_MESSAGE = 'Not built yet';
