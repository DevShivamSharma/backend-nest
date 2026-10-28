import type { UserType } from './user-type';

/** What the rest of the app knows about the signed-in user. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  type: UserType;
  /** ITPO role slugs from T_USERS_ROLES (e.g. "organizer", "itpo_admin"). */
  roles: string[];
  /** Set for organisers, null for ITPO staff. */
  orgId: string | null;
  /** An organiser's organisation, from `T_ORGANIZATION`; null for ITPO staff. */
  organisationName: string | null;
}

/** The session a request belongs to, put on the request by the sign-in guard. */
export interface RequestSession {
  id: string;
  /** When the access token in use expires. */
  expiresAt: Date;
}

/** The claims inside the access token: the same shape ITPO's own apps issue and read. */
export interface AccessTokenPayload {
  id: string;
  /** Added by the JWT library when signing: expiry, epoch seconds. */
  exp?: number;
  role: string[];
  sessionId: string;
  orgId: string | null;
}

/** The claims inside a refresh token: ITPO's `sessionId` and `hash`, plus the user it belongs to. */
export interface RefreshTokenPayload {
  id: string;
  sessionId: string;
  hash: string;
}
