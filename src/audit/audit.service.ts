import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import type { Actor } from '../common/http/authenticated-request';
import type { Page } from '../common/pagination';
import { AuditLogEntity } from './audit-log.entity';

export interface AuditEntry {
  action: string;
  actor?: Actor | null;
  organisationId?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditLogView {
  id: string;
  organisationId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditQuery {
  organisationId?: string;
  action?: string;
  page: number;
  pageSize: number;
}

/**
 * Append-only record of administrative actions. Entries written inside a transaction pass its
 * manager, so they commit or roll back with the change they describe.
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLogEntity) private readonly logs: Repository<AuditLogEntity>,
  ) {}

  async record(entry: AuditEntry, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(AuditLogEntity) : this.logs;
    await repo.save(
      repo.create({
        action: entry.action,
        organisationId: entry.organisationId ?? null,
        actorUserId: entry.actor?.id ?? null,
        actorEmail: entry.actor?.email ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: entry.metadata ?? {},
        ip: entry.ip ?? null,
      }),
    );
  }

  async list(query: AuditQuery): Promise<Page<AuditLogView>> {
    const qb = this.logs.createQueryBuilder('log').orderBy('log.createdAt', 'DESC');

    if (query.organisationId) {
      qb.andWhere('log.organisationId = :organisationId', { organisationId: query.organisationId });
    }
    if (query.action) {
      qb.andWhere('log.action LIKE :action', { action: `${query.action}%` });
    }

    const [rows, total] = await qb
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();

    return {
      items: rows.map((row) => ({
        id: row.id,
        organisationId: row.organisationId,
        actorEmail: row.actorEmail,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        metadata: row.metadata,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}
