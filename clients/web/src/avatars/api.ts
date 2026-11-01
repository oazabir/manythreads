import {
  MyAvatarResponse,
  SetBotAvatarRequest,
  SetBotAvatarResponse,
  SetMyAvatarRequest,
  UploadMyPhotoRequest,
  removeMyAvatarRoute,
  setBotAvatarRoute,
  setMyAvatarRoute,
  uploadMyPhotoRoute,
} from '@manythreads/shared';
import { call } from '../api/client';

/** What the picture pickers ask of the server (PLAN P14-23). */
export const chooseMyAvatar = (preset: string) => call(setMyAvatarRoute, { request: SetMyAvatarRequest, response: MyAvatarResponse }, SetMyAvatarRequest.parse({ preset }));
export const uploadMyPhoto = (body: UploadMyPhotoRequest) => call(uploadMyPhotoRoute, { request: UploadMyPhotoRequest, response: MyAvatarResponse }, body);
export const removeMyAvatar = () => call(removeMyAvatarRoute, { response: MyAvatarResponse });
export const chooseBotAvatar = (slug: string, botSlug: string, preset: string | null) =>
  call(setBotAvatarRoute, { request: SetBotAvatarRequest, response: SetBotAvatarResponse }, SetBotAvatarRequest.parse({ preset }), { slug, botSlug });
