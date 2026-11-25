import {
  listAppointmentsRoute,
  ListAppointmentsResponse,
  createAppointmentRoute,
  CreateAppointmentRequest,
  AppointmentResponse,
  updateAppointmentRoute,
  UpdateAppointmentRequest,
  cancelAppointmentRoute,
  joinAppointmentRoute,
  createMeetingSeriesRoute,
  CreateMeetingSeriesRequest,
  CreateMeetingSeriesResponse,
  updateMeetingSeriesRoute,
  UpdateMeetingSeriesRequest,
  MeetingSeriesResponse,
  stopMeetingSeriesRoute,
  openMeetingSpaceRoute,
  OpenMeetingSpaceRequest,
  OpenMeetingSpaceResponse,
  listMeetingSpacesRoute,
  ListMeetingSpacesResponse,
  meetingPeopleRoute,
  MeetingPeopleResponse,
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
  CallStartOptionsQuery,
  CallStartOptionsResponse,
  InviteToMeetingRequest,
  InviteToMeetingResponse,
  callStartOptionsRoute,
  inviteToMeetingRoute,
  AnswerShareRequest,
  AnswerShareResponse,
  AskToShareRequest,
  AskToShareResponse,
  answerShareRoute,
  askToShareRoute,
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
  DecideGuestResponse,
  MakeGuestLinkResponse,
  MeetingLobbyResponse,
  ListGuestLinksResponse,
  RevokeGuestLinkResponse,
  RevokeGuestLinksResponse,
  admitGuestRoute,
  denyGuestRoute,
  makeGuestLinkRoute,
  meetingLobbyRoute,
  removeGuestRoute,
  listGuestLinksRoute,
  revokeGuestLinkRoute,
  revokeGuestLinksRoute,
  MeetingAskRequest,
  MeetingAskResponse,
  MeetingAssistantStatus,
  MeetingCatchUpResponse,
  getMeetingAssistantRoute,
  meetingAskRoute,
  meetingCatchUpRoute,
} from '@manythreads/shared';
import { call } from '../api/client';

/** The voice-room routes (docs/plugins/meetings.md) as typed calls. The call controller uses them through `CallApi`, so a test can stand in for the server. */

export const startMeeting = (channelId: string, body: StartMeetingRequest = {}) =>
  call(startMeetingRoute, { request: StartMeetingRequest, response: StartMeetingResponse }, body, { channelId });
/** What the start dialog offers in a channel (P15-25): who can be asked, the note-taker, the default title; `q` narrows the people on the server. */
export const fetchCallOptions = (channelId: string, q = '') =>
  call(callStartOptionsRoute, { request: CallStartOptionsQuery, response: CallStartOptionsResponse }, q.trim() === '' ? {} : { q: q.trim() }, { channelId });
/** "Invite more" on a live call's card (P15-27): the people newly asked. */
export const inviteToMeeting = (meetingId: string, personIds: readonly string[]) =>
  call(inviteToMeetingRoute, { request: InviteToMeetingRequest, response: InviteToMeetingResponse }, { personIds: [...personIds] } as InviteToMeetingRequest, { meetingId });
/** "Ask to share" (P17-02): ask the person sharing a screen (`sharerActorId`) for a turn; one request waits per asker, for a minute. */
export const askToShare = (meetingId: string, sharerActorId: string) =>
  call(askToShareRoute, { request: AskToShareRequest, response: AskToShareResponse }, { sharerActorId } as AskToShareRequest, { meetingId });
/** The person sharing answers a request: `accept` (they stop sharing) or `decline` ("Not now"). */
export const answerShareRequest = (meetingId: string, requestId: string, answer: AnswerShareRequest['answer']) =>
  call(answerShareRoute, { request: AnswerShareRequest, response: AnswerShareResponse }, { answer }, { meetingId, requestId });
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

/** Opens a meeting space with its call (P36-03). */
export const openMeetingSpace = (body: OpenMeetingSpaceRequest) => call(openMeetingSpaceRoute, { request: OpenMeetingSpaceRequest, response: OpenMeetingSpaceResponse }, body);
/** The meeting spaces this person is in, newest first. */
export const fetchMeetingSpaces = () => call(listMeetingSpacesRoute, { response: ListMeetingSpacesResponse });
/** Who can be invited to a meeting, from every team, by name. */
export const fetchMeetingPeople = (q = '') => call(meetingPeopleRoute, { response: MeetingPeopleResponse }, { q });

/** The appointments the person may see in a window, across all their teams (P36-05). */
export const fetchAppointments = (from: string, to: string) => call(listAppointmentsRoute, { response: ListAppointmentsResponse }, { from, to });
export const createAppointment = (teamSlug: string, body: CreateAppointmentRequest) =>
  call(createAppointmentRoute, { request: CreateAppointmentRequest, response: AppointmentResponse }, body, { slug: teamSlug });
export const updateAppointment = (id: string, body: UpdateAppointmentRequest) => call(updateAppointmentRoute, { request: UpdateAppointmentRequest, response: AppointmentResponse }, body, { id });
export const cancelAppointment = (id: string) => call(cancelAppointmentRoute, { response: AppointmentResponse }, undefined, { id });
/** Its call in its meeting space: started with its kind, or joined when live (P36-07). */
/** Meeting series (P17-05): make one (its first meeting comes back), change its title or people, stop it. */
export const createMeetingSeries = (teamSlug: string, body: CreateMeetingSeriesRequest) =>
  call(createMeetingSeriesRoute, { request: CreateMeetingSeriesRequest, response: CreateMeetingSeriesResponse }, body, { slug: teamSlug });
export const updateMeetingSeries = (id: string, body: UpdateMeetingSeriesRequest) => call(updateMeetingSeriesRoute, { request: UpdateMeetingSeriesRequest, response: MeetingSeriesResponse }, body, { id });
export const stopMeetingSeries = (id: string) => call(stopMeetingSeriesRoute, { response: MeetingSeriesResponse }, undefined, { id });
export const joinAppointment = (id: string) => call(joinAppointmentRoute, { response: OpenMeetingSpaceResponse }, undefined, { id });

// ---- guest links and the waiting room (P17-04) -------------------------------------------------------------------------------------------------------
/** A guest link of this person's own for a live call with guest links on; the address is shown this once. */
export const makeGuestLink = (meetingId: string) => call(makeGuestLinkRoute, { response: MakeGuestLinkResponse }, undefined, { meetingId });
/** Turn guest links off for the call (the starter, a lead, an admin): every link stops; guests already in stay. */
export const revokeGuestLinks = (meetingId: string) => call(revokeGuestLinksRoute, { response: RevokeGuestLinksResponse }, undefined, { meetingId });
/** The links of the call that still work, for the starter, a lead or an admin ("Guest links (n)"). */
export const listGuestLinks = (meetingId: string) => call(listGuestLinksRoute, { response: ListGuestLinksResponse }, undefined, { meetingId });
/** Turn off one link; guest links stay on for the call. */
export const revokeGuestLink = (meetingId: string, linkId: string) => call(revokeGuestLinkRoute, { response: RevokeGuestLinkResponse }, undefined, { meetingId, linkId });
/** Who is waiting to be let in (only for someone in the call). */
export const fetchLobby = (meetingId: string) => call(meetingLobbyRoute, { response: MeetingLobbyResponse }, undefined, { meetingId });
/** Let a guest in, turn one away, or take one out. */
export const decideGuest = (meetingId: string, guestId: string, decision: 'admit' | 'deny' | 'remove') =>
  call(decision === 'admit' ? admitGuestRoute : decision === 'deny' ? denyGuestRoute : removeGuestRoute, { response: DecideGuestResponse }, undefined, { meetingId, guestId });

// ---- the meeting assistant (P17-06) ----
/** What the Ask panel may offer in this call now: who answers, and Catch me up, each with the reason when not. */
export const fetchAssistantStatus = (meetingId: string) => call(getMeetingAssistantRoute, { response: MeetingAssistantStatus }, undefined, { meetingId });
/** Ask a question about the call; the answer comes as a `meeting.ask` push (and in the call's thread). */
export const askAssistant = (meetingId: string, question: string) =>
  call(meetingAskRoute, { request: MeetingAskRequest, response: MeetingAskResponse }, { question }, { meetingId });
/** Ask for a summary of what was said before this person joined; it comes as a `meeting.catchup` push to them only. */
export const requestCatchUp = (meetingId: string) => call(meetingCatchUpRoute, { response: MeetingCatchUpResponse }, undefined, { meetingId });
