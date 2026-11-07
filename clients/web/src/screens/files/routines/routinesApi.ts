import {
  CreatePersonalRoutineRequest,
  CreatePersonalRoutineResponse,
  DeletePersonalRoutineResponse,
  DraftPersonalRoutineRequest,
  DraftPersonalRoutineResponse,
  ListPersonalRoutineRunsResponse,
  ListPersonalRoutinesResponse,
  RunPersonalRoutineResponse,
  UpdatePersonalRoutineRequest,
  UpdatePersonalRoutineResponse,
  UpdateRoutineSettingsRequest,
  UpdateRoutineSettingsResponse,
  createPersonalRoutineRoute,
  deletePersonalRoutineRoute,
  draftPersonalRoutineRoute,
  listPersonalRoutineRunsRoute,
  listPersonalRoutinesRoute,
  runPersonalRoutineRoute,
  updatePersonalRoutineRoute,
  updateRoutineSettingsRoute,
} from '@manythreads/shared';
import { call } from '../../../api/client';

/*
 * The calls behind a person's own routines (`/api/me/scheduled-jobs`, docs/plugins/scheduled-jobs.md). Every call is "mine": the server takes the person from the
 * session and never from the page. Nothing here turns a routine on by itself: `draftRoutine` only proposes, and `createRoutine` carries the person's own yes.
 */

export const fetchRoutines = () => call(listPersonalRoutinesRoute, { response: ListPersonalRoutinesResponse });

/** A sentence in, a proposal out. Nothing is saved. */
export const draftRoutine = (sentence: string, timeZone: string) =>
  call(draftPersonalRoutineRoute, { request: DraftPersonalRoutineRequest, response: DraftPersonalRoutineResponse }, DraftPersonalRoutineRequest.parse({ sentence, timeZone }));

/** The confirmed routine. `confirmed: true` is added here, so a caller can only reach this after the person pressed the confirm button. */
export const createRoutine = (body: Omit<CreatePersonalRoutineRequest, 'confirmed'>) =>
  call(createPersonalRoutineRoute, { request: CreatePersonalRoutineRequest, response: CreatePersonalRoutineResponse }, CreatePersonalRoutineRequest.parse({ ...body, confirmed: true }));

export const updateRoutine = (id: string, body: UpdatePersonalRoutineRequest) =>
  call(updatePersonalRoutineRoute, { request: UpdatePersonalRoutineRequest, response: UpdatePersonalRoutineResponse }, UpdatePersonalRoutineRequest.parse(body), { scheduledJobId: id });

export const deleteRoutine = (id: string) => call(deletePersonalRoutineRoute, { response: DeletePersonalRoutineResponse }, undefined, { scheduledJobId: id });

export const runRoutineNow = (id: string) => call(runPersonalRoutineRoute, { response: RunPersonalRoutineResponse }, undefined, { scheduledJobId: id });

export const fetchRoutineRuns = (id: string) => call(listPersonalRoutineRunsRoute, { response: ListPersonalRoutineRunsResponse }, undefined, { scheduledJobId: id });

export const saveRoutineSettings = (body: UpdateRoutineSettingsRequest) =>
  call(updateRoutineSettingsRoute, { request: UpdateRoutineSettingsRequest, response: UpdateRoutineSettingsResponse }, UpdateRoutineSettingsRequest.parse(body));
