import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import type { AuditService } from '../../audit/audit.service';
import type { SessionUser } from '../../auth/domain/session-user';
import { UserType } from '../../auth/domain/user-type';
import type { EmailRecipientListEntity } from '../infrastructure/persistence/relational/entities/email-recipient-list.entity';
import type { EmailRecipientEntity } from '../infrastructure/persistence/relational/entities/email-recipient.entity';
import { EmailRecipientsService } from './email-recipients.service';

const staff: SessionUser = {
  id: 's1',
  email: '',
  name: '',
  type: UserType.ItpoStaff,
  roles: [],
  orgId: null,
  organisationName: null,
};

/** An in-memory repository: only what the service uses (equality filters, no ordering needed). */
class FakeRepo<T extends object> {
  rows: T[] = [];
  private n = 0;

  constructor(
    private readonly key: keyof T,
    private readonly makeId = false,
  ) {}

  create(values: Partial<T>): T {
    return { ...values } as T;
  }

  async save(row: T): Promise<T> {
    if (this.makeId && !(row as Record<string, unknown>)[this.key as string]) {
      (row as Record<string, unknown>)[this.key as string] =
        `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
      (row as Record<string, unknown>)['createdAt'] = new Date(this.n);
    }
    if (!this.rows.includes(row)) this.rows.push(row);
    return row;
  }

  private match(where: Partial<T>): T[] {
    return this.rows.filter((r) =>
      (Object.keys(where) as (keyof T)[]).every((k) => r[k] === where[k]),
    );
  }

  async findOneBy(where: Partial<T>): Promise<T | null> {
    return this.match(where)[0] ?? null;
  }

  async find(options: { where?: Partial<T> } = {}): Promise<T[]> {
    return this.match(options.where ?? {});
  }

  async delete(where: Partial<T>): Promise<void> {
    this.rows = this.rows.filter((r) => !this.match(where).includes(r));
  }
}

function build() {
  const lists = new FakeRepo<EmailRecipientListEntity>('slug');
  const people = new FakeRepo<EmailRecipientEntity>('id', true);
  lists.rows.push(
    ...([
      { slug: 'plan-submitted', name: 'Plan sent', description: null, system: true, active: true },
      { slug: 'hall-report', name: 'Hall report', description: null, system: false, active: true },
    ] as EmailRecipientListEntity[]),
  );
  const audit = { record: jest.fn(async () => undefined) };
  const service = new EmailRecipientsService(
    lists as unknown as Repository<EmailRecipientListEntity>,
    people as unknown as Repository<EmailRecipientEntity>,
    audit as unknown as AuditService,
  );
  return { service, audit, lists, people };
}

describe('EmailRecipientsService', () => {
  it('should give a mail the switched-on people of its list, once each, in lower case', async () => {
    const { service } = build();
    await service.addRecipient('plan-submitted', { email: 'Asha@itpo.in' }, staff);
    await service.addRecipient('plan-submitted', { email: 'ravi@itpo.in' }, staff);
    const view = await service.one('plan-submitted');
    await service.updateRecipient('plan-submitted', view.people[1].id, { active: false }, staff);

    expect(await service.resolve('plan-submitted')).toEqual(['asha@itpo.in']);
  });

  it('should give nobody for a list that is off or does not exist', async () => {
    const { service } = build();
    await service.addRecipient('hall-report', { email: 'a@itpo.in' }, staff);
    await service.updateList('hall-report', { active: false }, staff);

    expect(await service.resolve('hall-report')).toEqual([]);
    expect(await service.resolve('no-such-list')).toEqual([]);
  });

  it('should add a list under a new slug, and refuse a slug that is taken', async () => {
    const { service, audit } = build();
    const created = await service.createList(
      { slug: 'convention-centre-report', name: 'Convention centre report' },
      staff,
    );

    expect(created.slug).toBe('convention-centre-report');
    expect(audit.record).toHaveBeenCalledWith(
      staff,
      expect.objectContaining({ action: 'recipients.changed' }),
    );
    await expect(
      service.createList({ slug: 'hall-report', name: 'Again' }, staff),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('should refuse the same address twice on one list, whatever its case', async () => {
    const { service } = build();
    await service.addRecipient('hall-report', { email: 'a@itpo.in' }, staff);

    await expect(
      service.addRecipient('hall-report', { email: 'A@ITPO.in' }, staff),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('should not delete a list the portal sends to, but delete one of staff', async () => {
    const { service, lists } = build();

    await expect(service.deleteList('plan-submitted', staff)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await service.deleteList('hall-report', staff);
    expect(lists.rows.map((l) => l.slug)).toEqual(['plan-submitted']);
  });

  it('should say so when the list or the person is not there', async () => {
    const { service } = build();

    await expect(service.one('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.removeRecipient('hall-report', '00000000-0000-4000-8000-000000000009', staff),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
