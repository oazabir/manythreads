import { createContext, useContext } from 'react';
import type { AnswerChip } from '@manythreads/shared';

// What the page around a surface lends to it (PLAN P9-05). A surface never holds an address, an image or a token: the manythreads parts carry an id and a
// label, and the page that mounts the surface says what that id is for the person looking (their own access, not the bot's). Every function is optional.
// With none given a part draws the label the bot wrote as a plain chip: nothing is looked up, nothing is opened. (Answering a part, a Button's press, is not
// here: it goes through `SurfaceActionsContext` in ./views.tsx, the one door out of a surface.)

export interface SurfaceHost {
  /** The name of a person as the viewer may see it, or null when they may not (then the label is used). */
  personName?: (id: string) => string | null;
  /** The name of a channel as the viewer may see it, or null when they may not. */
  channelName?: (id: string) => string | null;
  /** Open a channel the viewer can see. Without it a channel is drawn as a chip, not a link. */
  openChannel?: (id: string) => void;
  /** What a thing is called and, if it has one, its one-line summary, as the viewer may see it; null when they may not. */
  entity?: (entityType: string, id: string) => { label: string; summary?: string } | null;
  /** Where an approval stands, as the viewer may see it. */
  approvalStatus?: (id: string) => 'waiting' | 'approved' | 'declined' | 'expired' | null;
  /** What an Answer part needs from the page (P9-07): where its relative links go, the slug of another team, and what choosing a chip does (without it chips are inert). */
  answer?: {
    teamSlug: string | null;
    teamSlugOf?: (teamId: string) => string | null;
    onChip?: (chip: AnswerChip) => void;
  };
}

const NO_HOST: SurfaceHost = {};

export const SurfaceHostContext = createContext<SurfaceHost>(NO_HOST);

export function useSurfaceHost(): SurfaceHost {
  return useContext(SurfaceHostContext);
}
