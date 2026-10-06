import type { Permission } from './permissions';
import type { RoleScopeKind } from './role.entity';

export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  scopeKind: RoleScopeKind;
  /** Effective permissions: every permission for the locked owner role. */
  permissions: Permission[];
  isSystem: boolean;
  isLocked: boolean;
  /** Null for a platform-wide role. */
  organisation: { id: string; slug: string; name: string } | null;
}

export interface AdminRoleView extends RoleView {
  memberCount: number;
  openInvitationCount: number;
}

/** A role as an organisation's team page sees it. */
export interface AssignableRoleView extends RoleView {
  /** The current member may give this role now. */
  assignable: boolean;
  /** Why not, when it may not. */
  reason: string | null;
}

/** The short form attached to members, invitations and the signed-in user's memberships. */
export interface RoleRef {
  id: string;
  key: string;
  name: string;
}
