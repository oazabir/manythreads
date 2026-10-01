import { z } from 'zod';
import type { ApiRoute } from '../client/route.ts';
import { EmailAddress, NewPassword } from './password.ts';
import { AuthenticatedSession } from './session.ts';

/** `GET /api/bootstrap/:token`: 200 while the one-time link is valid, 410 once it is used, expired or unknown. */
export const CheckBootstrapResponse = z.object({ valid: z.literal(true) });
export type CheckBootstrapResponse = z.infer<typeof CheckBootstrapResponse>;
export const checkBootstrapRoute = { method: 'GET', path: '/api/bootstrap/:token' } as const satisfies ApiRoute;

export const BootstrapWorkspaceRequest = z.strictObject({
  workspaceName: z.string().trim().min(1, 'Name your workspace.').max(120),
  name: z.string().trim().min(1, 'Enter your name.').max(120),
  email: EmailAddress,
  password: NewPassword,
});
export type BootstrapWorkspaceRequest = z.infer<typeof BootstrapWorkspaceRequest>;

/** The new workspace owner is signed in (the session cookie is set) and gets the session payload. */
export const BootstrapWorkspaceResponse = AuthenticatedSession;
export type BootstrapWorkspaceResponse = z.infer<typeof BootstrapWorkspaceResponse>;
export const bootstrapWorkspaceRoute = { method: 'POST', path: '/api/bootstrap/:token' } as const satisfies ApiRoute;
