/**
 * The permission catalogue. Code enforces permissions, so the catalogue lives in code; which
 * role holds which permission is data the Super Admin edits (see RoleEntity).
 *
 * `available` is false while the module that checks a permission is not built yet. Such a
 * permission can already be given to a role and takes effect when its module arrives.
 */
export interface PermissionDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly available: boolean;
}

export interface PermissionGroup {
  readonly key: string;
  readonly label: string;
  readonly permissions: readonly PermissionDefinition[];
}

export const PERMISSION_GROUPS = [
  {
    key: 'organisation',
    label: 'Organisation',
    permissions: [
      {
        key: 'org.settings.view',
        label: 'See settings',
        description: 'Branding, languages, invoice and email details',
        available: true,
      },
      {
        key: 'org.settings.manage',
        label: 'Change settings',
        description: 'Edit branding and details; restore an earlier version',
        available: true,
      },
      {
        key: 'team.view',
        label: 'See the team',
        description: 'Members, their roles and open invitations',
        available: true,
      },
      {
        key: 'team.invite',
        label: 'Invite people',
        description: 'Only with roles whose permissions the inviter holds too',
        available: true,
      },
      {
        key: 'team.manage',
        label: 'Manage the team',
        description: 'Change roles, remove members, revoke invitations',
        available: true,
      },
      {
        key: 'audit.view',
        label: 'See the audit log',
        description: 'Who changed what in the organisation',
        available: true,
      },
    ],
  },
  {
    key: 'venues',
    label: 'Venues and halls',
    permissions: [
      {
        key: 'venues.view',
        label: 'See venues and halls',
        description: 'Sites, levels, halls and their plans',
        available: false,
      },
      {
        key: 'venues.manage',
        label: 'Manage venues and halls',
        description: 'Add and edit venues, halls and facilities',
        available: false,
      },
      {
        key: 'halls.import',
        label: 'Import floor plans',
        description: 'Digitize halls from DXF, PDF or images',
        available: false,
      },
    ],
  },
  {
    key: 'rules',
    label: 'Rules',
    permissions: [
      {
        key: 'rules.view',
        label: 'See rules',
        description: 'Safety and plotting rules',
        available: false,
      },
      {
        key: 'rules.manage',
        label: 'Manage rules',
        description: 'Switch rules on or off and set their values',
        available: false,
      },
    ],
  },
  {
    key: 'events',
    label: 'Events',
    permissions: [
      {
        key: 'events.view',
        label: 'See events',
        description: 'Events, their halls and dates',
        available: false,
      },
      {
        key: 'events.manage',
        label: 'Manage events',
        description: 'Create events and book halls for them',
        available: false,
      },
    ],
  },
  {
    key: 'layouts',
    label: 'Stall layouts',
    permissions: [
      {
        key: 'layouts.view',
        label: 'See layouts',
        description: 'Stall plans and their revisions',
        available: false,
      },
      {
        key: 'layouts.edit',
        label: 'Draw layouts',
        description: 'Draft stalls, import an architect PDF',
        available: false,
      },
      {
        key: 'layouts.approve',
        label: 'Approve layouts',
        description: 'Review and approve a revision',
        available: false,
      },
      {
        key: 'layouts.publish',
        label: 'Publish layouts',
        description: 'Send an approved layout to booking',
        available: false,
      },
    ],
  },
  {
    key: 'pricing',
    label: 'Pricing',
    permissions: [
      {
        key: 'pricing.view',
        label: 'See prices',
        description: 'Rate cards and stall prices',
        available: false,
      },
      {
        key: 'pricing.manage',
        label: 'Manage prices',
        description: 'Edit rate cards and stall prices',
        available: false,
      },
    ],
  },
  {
    key: 'bookings',
    label: 'Bookings',
    permissions: [
      {
        key: 'stalls.book',
        label: 'Book stalls',
        description: 'Hold and book stalls as an exhibitor',
        available: false,
      },
      {
        key: 'bookings.view',
        label: 'See bookings',
        description: 'All bookings of the events in scope',
        available: false,
      },
      {
        key: 'bookings.manage',
        label: 'Manage bookings',
        description: 'Confirm, move or cancel bookings',
        available: false,
      },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    permissions: [
      {
        key: 'reports.view',
        label: 'See reports',
        description: 'Occupancy, revenue and safety dashboards',
        available: false,
      },
    ],
  },
] as const satisfies readonly PermissionGroup[];

/** A permission key from the catalogue, checked at compile time where routes declare them. */
export type Permission = (typeof PERMISSION_GROUPS)[number]['permissions'][number]['key'];

export const ALL_PERMISSIONS: readonly Permission[] = PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => permission.key),
);

const KNOWN: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermission(key: string): key is Permission {
  return KNOWN.has(key);
}

/** Catalogue order, duplicates and unknown keys removed. */
export function normalisePermissions(keys: readonly string[]): Permission[] {
  const wanted = new Set(keys);
  return ALL_PERMISSIONS.filter((key) => wanted.has(key));
}

/** True when every permission of `wanted` is in `held`. */
export function holdsAll(held: readonly string[], wanted: readonly string[]): boolean {
  const set = new Set(held);
  return wanted.every((key) => set.has(key));
}
