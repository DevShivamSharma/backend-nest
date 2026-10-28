import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { SessionUser } from '../auth/domain/session-user';
import type { AuditAction } from './audit-actions';

export interface AuditEntry {
  action: AuditAction;
  event?: { id: string; name: string | null } | null;
  hall?: { id: string; name: string | null } | null;
  /** A short sentence of what changed: a revision, a note, a count. */
  detail?: string | null;
}

export interface AuditRow {
  id: string;
  at: string;
  actor: { id: string | null; name: string | null; email: string | null; type: string | null };
  action: AuditAction;
  event: { id: string | null; name: string | null };
  hall: { id: string | null; name: string | null };
  detail: string | null;
}

export interface AuditQuery {
  action?: string;
  /** Text in the event's name. */
  event?: string;
  /** Text in the actor's name or email. */
  user?: string;
  /** Days, `YYYY-MM-DD` (India), both included. */
  from?: string;
  to?: string;
  page: number;
  size: number;
}

interface Raw {
  id: string;
  at: Date;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  actor_type: string | null;
  action: AuditAction;
  event_id: string | null;
  event_name: string | null;
  event_hall_id: string | null;
  hall_name: string | null;
  detail: string | null;
}

const IST = 'Asia/Kolkata';

/**
 * The audit trail: who did what, kept in `T_STALL_AUDIT_LOG`. Recording never fails the action
 * it records: a problem is logged and the action goes on.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: DataSource) {}

  async record(user: SessionUser, entry: AuditEntry): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO idp."T_STALL_AUDIT_LOG"
           (actor_id, actor_name, actor_email, actor_type, action, event_id, event_name,
            event_hall_id, hall_name, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          user.id,
          user.name,
          user.email,
          user.type,
          entry.action,
          entry.event?.id ?? null,
          entry.event?.name?.slice(0, 300) ?? null,
          entry.hall?.id ?? null,
          entry.hall?.name?.slice(0, 300) ?? null,
          entry.detail?.slice(0, 1000) ?? null,
        ],
      );
    } catch (error) {
      this.logger.warn(
        `Audit entry ${entry.action} was not recorded: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async list(
    q: AuditQuery,
  ): Promise<{ items: AuditRow[]; total: number; page: number; size: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (q.action) add('action = ?', q.action);
    if (q.event) add(`event_name ILIKE '%' || ? || '%'`, escape(q.event));
    if (q.user)
      add(
        `(actor_name ILIKE '%' || ? || '%' OR actor_email ILIKE '%' || ? || '%')`,
        escape(q.user),
      );
    if (q.from) add(`at >= (?::date)::timestamp AT TIME ZONE '${IST}'`, q.from);
    if (q.to) add(`at < ((?::date + 1)::timestamp AT TIME ZONE '${IST}')`, q.to);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [count] = await this.db.query<Array<{ n: string }>>(
      `SELECT count(*) AS n FROM idp."T_STALL_AUDIT_LOG" ${clause}`,
      params,
    );
    const rows = await this.db.query<Raw[]>(
      `SELECT * FROM idp."T_STALL_AUDIT_LOG" ${clause} ORDER BY at DESC, id
        LIMIT ${q.size} OFFSET ${(q.page - 1) * q.size}`,
      params,
    );
    return {
      items: rows.map(toRow),
      total: Number(count?.n ?? 0),
      page: q.page,
      size: q.size,
    };
  }
}

/** Text to look for, with LIKE's own characters taken literally. */
function escape(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

function toRow(r: Raw): AuditRow {
  return {
    id: r.id,
    at: new Date(r.at).toISOString(),
    actor: { id: r.actor_id, name: r.actor_name, email: r.actor_email, type: r.actor_type },
    action: r.action,
    event: { id: r.event_id, name: r.event_name },
    hall: { id: r.event_hall_id, name: r.hall_name },
    detail: r.detail,
  };
}
