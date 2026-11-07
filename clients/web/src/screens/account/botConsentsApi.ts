import { ListBotConsentsResponse, SetBotConsentRequest, SetBotConsentResponse, listBotConsentsRoute, setBotConsentRoute } from '@manythreads/shared';
import { call } from '../../api/client';

/** Which bots may read your Personal space (`/api/me/bot-consents`). The person is the signed-in one; the server never takes a person from the page. */
export const fetchBotConsents = () => call(listBotConsentsRoute, { response: ListBotConsentsResponse });

export const setBotConsent = (botId: string, allowed: boolean) =>
  call(setBotConsentRoute, { request: SetBotConsentRequest, response: SetBotConsentResponse }, SetBotConsentRequest.parse({ allowed }), { botId });
