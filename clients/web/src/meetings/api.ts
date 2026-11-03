import {
  EndMeetingResponse,
  GetMeetingResponse,
  GetMeetingTranscriptResponse,
  JoinMeetingResponse,
  LeaveMeetingResponse,
  ListMeetingsResponse,
  MediaStatusResponse,
  MeetingConsentRequest,
  MeetingConsentResponse,
  MeetingHeartbeatRequest,
  MeetingHeartbeatResponse,
  MeetingsSettings,
  MeetingsSettingsUpdate,
  MeetingTranscriptionState,
  RenewMeetingTokenResponse,
  SetMeetingTranscriptionRequest,
  StartMeetingRequest,
  StartMeetingResponse,
  endMeetingRoute,
  getMeetingRoute,
  getMeetingTranscriptRoute,
  getMeetingTranscriptionRoute,
  getMeetingsSettingsRoute,
  heartbeatMeetingRoute,
  joinMeetingRoute,
  leaveMeetingRoute,
  listMyLiveMeetingsRoute,
  mediaStatusRoute,
  meetingConsentRoute,
  putMeetingsSettingsRoute,
  renewMeetingTokenRoute,
  setMeetingTranscriptionRoute,
  startMeetingRoute,
} from '@manythreads/shared';
import { call } from '../api/client';

/** The voice-room routes (docs/plugins/meetings.md) as typed calls. The call controller uses them through `CallApi`, so a test can stand in for the server. */

export const startMeeting = (channelId: string, body: StartMeetingRequest = {}) =>
  call(startMeetingRoute, { request: StartMeetingRequest, response: StartMeetingResponse }, body, { channelId });
export const joinMeeting = (meetingId: string) => call(joinMeetingRoute, { response: JoinMeetingResponse }, undefined, { meetingId });
export const renewMeetingToken = (meetingId: string) => call(renewMeetingTokenRoute, { response: RenewMeetingTokenResponse }, undefined, { meetingId });
export const leaveMeeting = (meetingId: string) => call(leaveMeetingRoute, { response: LeaveMeetingResponse }, undefined, { meetingId });
export const endMeeting = (meetingId: string) => call(endMeetingRoute, { response: EndMeetingResponse }, undefined, { meetingId });
export const fetchMeeting = (meetingId: string) => call(getMeetingRoute, { response: GetMeetingResponse }, undefined, { meetingId });
export const heartbeatMeeting = (meetingId: string, speaking: boolean) =>
  call(heartbeatMeetingRoute, { request: MeetingHeartbeatRequest, response: MeetingHeartbeatResponse }, { speaking }, { meetingId });
export const fetchLiveMeetings = () => call(listMyLiveMeetingsRoute, { response: ListMeetingsResponse });
export const fetchMediaStatus = () => call(mediaStatusRoute, { response: MediaStatusResponse });

export const fetchTranscription = (meetingId: string) => call(getMeetingTranscriptionRoute, { response: MeetingTranscriptionState }, undefined, { meetingId });
export const setTranscription = (meetingId: string, mode: SetMeetingTranscriptionRequest['mode']) =>
  call(setMeetingTranscriptionRoute, { request: SetMeetingTranscriptionRequest, response: MeetingTranscriptionState }, { mode }, { meetingId });
export const answerConsent = (meetingId: string, answer: MeetingConsentRequest['transcribe']) =>
  call(meetingConsentRoute, { request: MeetingConsentRequest, response: MeetingConsentResponse }, { transcribe: answer }, { meetingId });
export const fetchTranscript = (meetingId: string) => call(getMeetingTranscriptRoute, { response: GetMeetingTranscriptResponse }, undefined, { meetingId });

export const fetchMeetingsSettings = () => call(getMeetingsSettingsRoute, { response: MeetingsSettings });
export const saveMeetingsSettings = (body: MeetingsSettingsUpdate) => call(putMeetingsSettingsRoute, { request: MeetingsSettingsUpdate, response: MeetingsSettings }, body);

/** The calls the call controller makes, as one object: the page passes the real ones, a test passes a stand-in for the server. */
export type CallApi = {
  start: typeof startMeeting;
  join: typeof joinMeeting;
  renew: typeof renewMeetingToken;
  leave: typeof leaveMeeting;
  end: typeof endMeeting;
  get: typeof fetchMeeting;
  heartbeat: typeof heartbeatMeeting;
  transcription: typeof fetchTranscription;
  setTranscription: typeof setTranscription;
  consent: typeof answerConsent;
};

export const realCallApi: CallApi = {
  start: startMeeting,
  join: joinMeeting,
  renew: renewMeetingToken,
  leave: leaveMeeting,
  end: endMeeting,
  get: fetchMeeting,
  heartbeat: heartbeatMeeting,
  transcription: fetchTranscription,
  setTranscription,
  consent: answerConsent,
};
