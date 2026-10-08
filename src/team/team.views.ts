import type { MembershipScope } from '../access/membership-scope';
import type { RoleRef } from '../roles/role.views';

export interface MemberView {
  id: string;
  user: { id: string; name: string; email: string; lastLoginAt: string | null };
  role: RoleRef;
  scope: MembershipScope;
  joinedAt: string;
}

export interface InvitationView {
  id: string;
  email: string;
  role: RoleRef;
  /** The events (and exhibitor) an event role is given for; empty for the whole organisation. */
  scope: MembershipScope;
  invitedBy: { name: string; email: string } | null;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface CreatedInvitationView extends InvitationView {
  /**
   * The link itself, only while email goes to the server log: the inviter passes it on.
   * Null once a real email provider sends it.
   */
  inviteUrl: string | null;
}

/** What the accept page shows before the person signs in. */
export interface InvitationPreview {
  organisation: { slug: string; name: string };
  email: string;
  role: RoleRef;
  /** An account with this email exists, so the person signs in rather than choosing a password. */
  accountExists: boolean;
  expiresAt: string;
}
