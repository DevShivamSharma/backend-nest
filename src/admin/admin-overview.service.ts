import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditLogView, AuditService } from '../audit/audit.service';
import { OrganisationsService, OrganisationSummary } from '../organisations/organisations.service';

export interface AttentionItem {
  id: string;
  slug: string;
  name: string;
  /** Suspended, or created but nobody has joined yet. */
  reason: 'suspended' | 'awaiting_admin';
  since: string;
}

export interface AdminOverview {
  organisations: { total: number; active: number; suspended: number };
  people: { users: number; memberships: number; openInvitations: number };
  roles: { platform: number; custom: number };
  attention: AttentionItem[];
  latestOrganisations: OrganisationSummary[];
  recentActivity: AuditLogView[];
}

interface CountsRow {
  org_total: number;
  org_active: number;
  org_suspended: number;
  users: number;
  memberships: number;
  open_invitations: number;
  platform_roles: number;
  custom_roles: number;
}

interface AttentionRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  updated_at: Date;
  created_at: Date;
}

/** The numbers and lists on the console's home page, in a handful of queries. */
@Injectable()
export class AdminOverviewService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly organisations: OrganisationsService,
    private readonly audit: AuditService,
  ) {}

  async overview(): Promise<AdminOverview> {
    const [[counts], attention, latest, activity] = await Promise.all([
      this.dataSource.query<CountsRow[]>(`
        SELECT
          (SELECT count(*) FROM organisations) AS org_total,
          (SELECT count(*) FROM organisations WHERE status = 'active') AS org_active,
          (SELECT count(*) FROM organisations WHERE status = 'suspended') AS org_suspended,
          (SELECT count(*) FROM users WHERE NOT is_platform_admin) AS users,
          (SELECT count(*) FROM memberships) AS memberships,
          (SELECT count(*) FROM invitations
             WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS open_invitations,
          (SELECT count(*) FROM roles WHERE organisation_id IS NULL) AS platform_roles,
          (SELECT count(*) FROM roles WHERE organisation_id IS NOT NULL) AS custom_roles
      `),
      this.dataSource.query<AttentionRow[]>(`
        SELECT o.id, o.slug, o.name, o.status, o.updated_at, o.created_at
          FROM organisations o
         WHERE o.status = 'suspended'
            OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organisation_id = o.id)
         ORDER BY o.updated_at DESC
         LIMIT 6
      `),
      this.organisations.list({ sort: 'newest', page: 1, pageSize: 6 }),
      this.audit.list({ page: 1, pageSize: 8 }),
    ]);

    return {
      organisations: {
        total: Number(counts.org_total),
        active: Number(counts.org_active),
        suspended: Number(counts.org_suspended),
      },
      people: {
        users: Number(counts.users),
        memberships: Number(counts.memberships),
        openInvitations: Number(counts.open_invitations),
      },
      roles: { platform: Number(counts.platform_roles), custom: Number(counts.custom_roles) },
      attention: attention.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        reason: row.status === 'suspended' ? 'suspended' : 'awaiting_admin',
        since: (row.status === 'suspended' ? row.updated_at : row.created_at).toISOString(),
      })),
      latestOrganisations: latest.items,
      recentActivity: activity.items,
    };
  }
}
