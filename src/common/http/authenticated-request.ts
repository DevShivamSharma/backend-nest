import type { Request } from 'express';

import type { MembershipEntity } from '../../access/membership.entity';
import type { OrganisationEntity } from '../../organisations/organisation.entity';
import type { Permission } from '../../roles/permissions';

/** The signed-in user, as the access-token guard attaches it to the request. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

/**
 * A request after the guards ran: `user` from the access-token guard, `access` from the
 * organisation access guard on `/orgs/:slug/...` routes.
 */
export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  access?: OrgAccessContext;
}

/** What the organisation access guard established for an `/orgs/:slug/...` request. */
export interface OrgAccessContext {
  organisation: OrganisationEntity;
  /** Loaded with its role. */
  membership: MembershipEntity;
  /** The role's effective permissions. */
  permissions: readonly Permission[];
}

/** Who performed an action, for the audit log. */
export interface Actor {
  id: string;
  email: string;
}

/** Client details recorded with sessions and audit entries. */
export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export function clientInfo(request: Request): ClientInfo {
  const userAgent = request.get('user-agent');
  return {
    ip: request.ip ?? null,
    userAgent: userAgent ? userAgent.slice(0, 255) : null,
  };
}
