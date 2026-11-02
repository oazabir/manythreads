import {
  DisconnectPersonConnectionResponse,
  ListPersonConnectionsResponse,
  StartPersonConnectionRequest,
  StartPersonConnectionResponse,
  disconnectPersonConnectionRoute,
  listPersonConnectionsRoute,
  startPersonConnectionRoute,
  type PersonProviderId,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the person's connected-accounts page asks of the server (docs/plugins/connections.md, "Person connections"). The tokens a provider hands back are sealed
 * by the server and never returned by any route: the page only learns whether a connection works, whose account it is and which services were agreed to.
 */

export const fetchPersonProviders = () => call(listPersonConnectionsRoute, { response: ListPersonConnectionsResponse });

/** Where to send the browser: the provider's own consent page. `services` left out asks for the provider's usual read-only set. */
export const startPersonConnection = (provider: PersonProviderId, body: StartPersonConnectionRequest = {}) =>
  call(startPersonConnectionRoute, { request: StartPersonConnectionRequest, response: StartPersonConnectionResponse }, body, { provider });

export const disconnectPersonConnection = (provider: PersonProviderId) =>
  call(disconnectPersonConnectionRoute, { response: DisconnectPersonConnectionResponse }, undefined, { provider });
