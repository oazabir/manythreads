import {
  EndTerminalRequest,
  OpenTerminalRequest,
  TerminalRecordingResponse,
  TerminalSessionResponse,
  TerminalStatusResponse,
  endTerminalRoute,
  getTerminalRoute,
  openTerminalRoute,
  terminalSocketRoute,
  terminalStatusRoute,
} from '@manythreads/shared';
import { buildPath, call } from '../../../api/client';

/*
 * What the Terminal view asks of the server (PLAN P7-09). Every call is for a workspace admin; the server answers anyone else with a plain refusal, shown as it comes.
 */

export const terminalStatus = (slug: string, botSlug: string) => call(terminalStatusRoute, { response: TerminalStatusResponse }, undefined, { slug, botSlug });

export const openTerminal = (slug: string, botSlug: string) =>
  call(openTerminalRoute, { request: OpenTerminalRequest, response: TerminalSessionResponse }, OpenTerminalRequest.parse({}), { slug, botSlug });

export const endTerminal = (slug: string, botSlug: string, terminalId: string) =>
  call(endTerminalRoute, { request: EndTerminalRequest, response: TerminalSessionResponse }, EndTerminalRequest.parse({}), { slug, botSlug, terminalId });

export const fetchTerminalRecord = (slug: string, botSlug: string, terminalId: string) =>
  call(getTerminalRoute, { response: TerminalRecordingResponse }, undefined, { slug, botSlug, terminalId });

/** The address of one terminal's socket on this site (same origin, so the signed-in cookie goes with it). */
export function terminalSocketUrl(slug: string, botSlug: string, terminalId: string, loc: { protocol: string; host: string } = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${buildPath(terminalSocketRoute.path, { slug, botSlug, terminalId })}`;
}
