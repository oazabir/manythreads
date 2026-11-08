import { HttpError } from '@manythreads/sdk';

// The stub every Bundle D route of this plugin answers with until the work package that owns it fills the handler in (docs/plugins/meetings.md "Bundle D contracts").
// Nothing else in the callers changes when a package replaces a stub: the path, the schemas and the rate limit are the contract.
export const notBuilt = (): never => {
  throw new HttpError(501, 'internal', 'Not built yet');
};
