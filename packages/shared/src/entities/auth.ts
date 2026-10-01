import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import {
  AuthProviderId,
  EmailVerificationId,
  IdentityId,
  InvitationId,
  PersonId,
  SecretId,
  SessionId,
  TeamId,
  WorkspaceId,
} from '../ids.ts';
import { JsonObject } from './kernel.ts';

// PLAN.md A.2 sign-in tables. Enums match the SQL CHECKs in 0004_identity.sql and 0005_sessions.sql exactly.
// Nothing secret lives in these types: password hashes, token hashes' preimages, and secret bytes are never
// mapped (the kernel reads `password_credentials.hash` and `invitations.token_hash` with its own queries).

export const AuthProviderKind = z.enum(['google', 'microsoft', 'password', 'oidc']);
export type AuthProviderKind = z.infer<typeof AuthProviderKind>;

/** A sign-in method. `config` holds no secrets; the client secret is `secretId` (never readable by clients). */
export const AuthProvider = z.object({
  id: AuthProviderId,
  workspaceId: WorkspaceId,
  kind: AuthProviderKind,
  config: JsonObject,
  secretId: SecretId.nullable(),
  enabled: z.boolean(),
  allowedDomains: z.array(z.string()),
  /** Why a provider is disabled (e.g. failed OIDC discovery); shown to admins. */
  disabledReason: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AuthProvider = z.infer<typeof AuthProvider>;

/** Metadata of an envelope-encrypted secret. The ciphertext and wrapped key are not part of any shared type. */
export const Secret = z.object({
  id: SecretId,
  keyId: z.string().min(1),
  createdAt: IsoDateTime,
});
export type Secret = z.infer<typeof Secret>;

/** A provider subject linked to a person. */
export const Identity = z.object({
  id: IdentityId,
  workspaceId: WorkspaceId,
  personId: PersonId,
  providerId: AuthProviderId,
  subject: z.string().min(1),
  createdAt: IsoDateTime,
});
export type Identity = z.infer<typeof Identity>;

/** Whether a person has a password (the argon2id hash itself is never mapped). */
export const PasswordCredential = z.object({
  personId: PersonId,
  mustChange: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PasswordCredential = z.infer<typeof PasswordCredential>;

export const Session = z.object({
  id: SessionId,
  workspaceId: WorkspaceId,
  personId: PersonId,
  createdAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  /** Absolute expiry; idle expiry is `lastSeenAt` plus the configured idle timeout. */
  expiresAt: IsoDateTime,
  device: z.string().nullable(),
  revokedAt: IsoDateTime.nullable(),
});
export type Session = z.infer<typeof Session>;

/** Hot token lookup (UNLOGGED). `tokenHash` is the hex sha256 of the cookie token, never the token itself. */
export const SessionCacheEntry = z.object({
  tokenHash: z.string().regex(/^[0-9a-f]+$/),
  sessionId: SessionId,
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime,
});
export type SessionCacheEntry = z.infer<typeof SessionCacheEntry>;

/** The workspace role an invitation can confer (never `owner`). A guest invitation has no team. */
export const InvitationRole = z.enum(['admin', 'member', 'guest']);
export type InvitationRole = z.infer<typeof InvitationRole>;

export const Invitation = z.object({
  id: InvitationId,
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  email: z.string().min(3),
  role: InvitationRole,
  /** What accepting grants besides the workspace role: `{ teamRole }`, later `{ channels }`. */
  grant: JsonObject,
  invitedBy: PersonId.nullable(),
  expiresAt: IsoDateTime,
  acceptedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Invitation = z.infer<typeof Invitation>;

export const EmailVerificationPurpose = z.enum(['verify_email', 'reset_password']);
export type EmailVerificationPurpose = z.infer<typeof EmailVerificationPurpose>;

export const EmailVerification = z.object({
  id: EmailVerificationId,
  workspaceId: WorkspaceId,
  personId: PersonId,
  purpose: EmailVerificationPurpose,
  /** The address being verified (null for a password reset to the primary address). */
  email: z.string().nullable(),
  expiresAt: IsoDateTime,
  usedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type EmailVerification = z.infer<typeof EmailVerification>;
