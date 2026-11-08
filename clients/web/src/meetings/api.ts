import {
  CancelScheduledMeetingResponse,
  CreateScheduledMeetingRequest,
  CreateScheduledMeetingResponse,
  GetScheduledMeetingResponse,
  JoinScheduledMeetingResponse,
  ListScheduledMeetingsQuery,
  ListScheduledMeetingsResponse,
  UpdateScheduledMeetingRequest,
  UpdateScheduledMeetingResponse,
  cancelScheduledMeetingRoute,
  createScheduledMeetingRoute,
  getScheduledMeetingRoute,
  joinScheduledMeetingRoute,
  listScheduledMeetingsRoute,
  updateScheduledMeetingRoute,
  CreateMeetingShareRequest,
  CreateMeetingShareResponse,
  DeleteMeetingShareResponse,
  EndMeetingResponse,
  GetMeetingByPathQuery,
  GetMeetingByPathResponse,
  GetMeetingNotesResponse,
  GetMeetingOverviewResponse,
  ListMeetingNotetakersResponse,
  ListMeetingSharesResponse,
  MeetingRecordConsentRequest,
  MeetingRecordConsentResponse,
  MeetingRecordingState,
  PatchMeetingSegmentRequest,
  PatchMeetingSegmentResponse,
  PostMeetingSegmentsRequest,
  PostMeetingSegmentsResponse,
  PutMeetingNotesRequest,
  PutMeetingNotesResponse,
  RemoveMeetingNotetakerResponse,
  SaveMeetingToTeamRequest,
  SaveMeetingToTeamResponse,
  SendMeetingToMemoryRequest,
  SendMeetingToMemoryResponse,
  SetMeetingNotetakerRequest,
  SetMeetingNotetakerResponse,
  SetMeetingRecordingRequest,
  SetMeetingRecordingResponse,
  createMeetingShareRoute,
  deleteMeetingShareRoute,
  getMeetingByPathRoute,
  getMeetingNotesRoute,
  getMeetingOverviewRoute,
  getMeetingRecordingRoute,
  listMeetingNotetakersRoute,
  listMeetingSharesRoute,
  meetingRecordConsentRoute,
  patchMeetingSegmentRoute,
  postMeetingSegmentsRoute,
  putMeetingNotesRoute,
  removeMeetingNotetakerRoute,
  saveMeetingToTeamRoute,
  sendMeetingToMemoryRoute,
  setMeetingNotetakerRoute,
  setMeetingRecordingRoute,
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

// ---- Bundle C: lines, notes, the note-taker, sharing and recording (docs/plugins/meetings.md "Bundle C contracts") ------------------------------------------------
/** Send the lines this device heard from its own person (final lines are stored; partial ones only become captions). At most 20 at once. */
export const postSegments = (meetingId: string, body: PostMeetingSegmentsRequest) =>
  call(postMeetingSegmentsRoute, { request: PostMeetingSegmentsRequest, response: PostMeetingSegmentsResponse }, body, { meetingId });
/** Correct the words of your own line (for 24 hours). */
export const correctSegment = (meetingId: string, segId: string, text: string) =>
  call(patchMeetingSegmentRoute, { request: PatchMeetingSegmentRequest, response: PatchMeetingSegmentResponse }, { text }, { meetingId, segId });

export const fetchMeetingOverview = (meetingId: string) => call(getMeetingOverviewRoute, { response: GetMeetingOverviewResponse }, undefined, { meetingId });
export const fetchMeetingByPath = (query: GetMeetingByPathQuery) =>
  call(getMeetingByPathRoute, { request: GetMeetingByPathQuery, response: GetMeetingByPathResponse }, query);
export const fetchMeetingNotes = (meetingId: string) => call(getMeetingNotesRoute, { response: GetMeetingNotesResponse }, undefined, { meetingId });
export const saveMeetingNotes = (meetingId: string, body: PutMeetingNotesRequest) =>
  call(putMeetingNotesRoute, { request: PutMeetingNotesRequest, response: PutMeetingNotesResponse }, body, { meetingId });
export const sendMeetingToMemory = (meetingId: string, body: SendMeetingToMemoryRequest) =>
  call(sendMeetingToMemoryRoute, { request: SendMeetingToMemoryRequest, response: SendMeetingToMemoryResponse }, body, { meetingId });
export const saveMeetingToTeam = (meetingId: string, body: SaveMeetingToTeamRequest) =>
  call(saveMeetingToTeamRoute, { request: SaveMeetingToTeamRequest, response: SaveMeetingToTeamResponse }, body, { meetingId });

export const fetchMeetingShares = (meetingId: string) => call(listMeetingSharesRoute, { response: ListMeetingSharesResponse }, undefined, { meetingId });
export const shareMeeting = (meetingId: string, body: CreateMeetingShareRequest) =>
  call(createMeetingShareRoute, { request: CreateMeetingShareRequest, response: CreateMeetingShareResponse }, body, { meetingId });
export const unshareMeeting = (meetingId: string, shareId: string) => call(deleteMeetingShareRoute, { response: DeleteMeetingShareResponse }, undefined, { meetingId, shareId });

export const fetchNotetakers = (meetingId: string) => call(listMeetingNotetakersRoute, { response: ListMeetingNotetakersResponse }, undefined, { meetingId });
export const addNotetaker = (meetingId: string, botId: string) =>
  call(setMeetingNotetakerRoute, { request: SetMeetingNotetakerRequest, response: SetMeetingNotetakerResponse }, { botId } as SetMeetingNotetakerRequest, { meetingId });
export const removeNotetaker = (meetingId: string) => call(removeMeetingNotetakerRoute, { response: RemoveMeetingNotetakerResponse }, undefined, { meetingId });

export const fetchRecording = (meetingId: string) => call(getMeetingRecordingRoute, { response: MeetingRecordingState }, undefined, { meetingId });
export const setRecording = (meetingId: string, on: boolean) =>
  call(setMeetingRecordingRoute, { request: SetMeetingRecordingRequest, response: SetMeetingRecordingResponse }, { on }, { meetingId });
export const answerRecordConsent = (meetingId: string, answer: MeetingRecordConsentRequest['record']) =>
  call(meetingRecordConsentRoute, { request: MeetingRecordConsentRequest, response: MeetingRecordConsentResponse }, { record: answer }, { meetingId });

// The server fallback upload (`POST /api/meetings/:id/audio-chunks`, a WAV body) is not here: `call` sends JSON, so the fallback client (work package W1) sends it with `fetch`.

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

// ---- Bundle D: rooms planned ahead (docs/plugins/meetings.md "Bundle D contracts") ----------------------------------------------------------------------------
/** Plan a room in a channel: the plan, and an event at the caller's own calendar with the join link in it. */
export const createScheduledMeeting = (channelId: string, body: CreateScheduledMeetingRequest) =>
  call(createScheduledMeetingRoute, { request: CreateScheduledMeetingRequest, response: CreateScheduledMeetingResponse }, body, { channelId });
export const fetchScheduledMeetings = (channelId: string, query: ListScheduledMeetingsQuery = { limit: 50 }) =>
  call(listScheduledMeetingsRoute, { request: ListScheduledMeetingsQuery, response: ListScheduledMeetingsResponse }, query, { channelId });
export const fetchScheduledMeeting = (scheduledMeetingId: string) =>
  call(getScheduledMeetingRoute, { response: GetScheduledMeetingResponse }, undefined, { scheduledMeetingId });
export const updateScheduledMeeting = (scheduledMeetingId: string, body: UpdateScheduledMeetingRequest) =>
  call(updateScheduledMeetingRoute, { request: UpdateScheduledMeetingRequest, response: UpdateScheduledMeetingResponse }, body, { scheduledMeetingId });
export const cancelScheduledMeeting = (scheduledMeetingId: string) =>
  call(cancelScheduledMeetingRoute, { response: CancelScheduledMeetingResponse }, undefined, { scheduledMeetingId });
export const joinScheduledMeeting = (scheduledMeetingId: string) =>
  call(joinScheduledMeetingRoute, { response: JoinScheduledMeetingResponse }, undefined, { scheduledMeetingId });
