import type { RoleRef } from '../roles/role.views';

export interface UserView {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

/** Returned by every call that signs someone in; the refresh token travels as a cookie. */
export interface SessionView {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: UserView;
}

export interface AcceptedInvitationView extends SessionView {
  organisationSlug: string;
}

export interface MembershipSummary {
  id: string;
  organisation: { id: string; slug: string; name: string };
  role: RoleRef;
}

export interface MeView {
  user: UserView;
  memberships: MembershipSummary[];
}

/** Local development only: one account the quick-login page offers, and where it lands. */
export interface DevLoginView {
  email: string;
  name: string;
  organisation: { slug: string; name: string };
  role: string;
  roleKey: string;
  landing: string;
}
