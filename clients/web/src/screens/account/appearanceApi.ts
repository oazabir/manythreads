import { MyAppearanceResponse, SetMyAppearanceRequest, setMyAppearanceRoute } from '@manythreads/shared';
import { call } from '../../api/client';

/** Saves the caller's theme and/or message density (P21-21). Only the fields given change; the answer is what is stored now. */
export const saveMyAppearance = (body: SetMyAppearanceRequest) =>
  call(setMyAppearanceRoute, { request: SetMyAppearanceRequest, response: MyAppearanceResponse }, SetMyAppearanceRequest.parse(body));
