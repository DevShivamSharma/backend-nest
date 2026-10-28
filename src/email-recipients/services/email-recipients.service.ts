import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditService } from '../../audit/audit.service';
import type { SessionUser } from '../../auth/domain/session-user';
import { EmailRecipientListEntity } from '../infrastructure/persistence/relational/entities/email-recipient-list.entity';
import { EmailRecipientEntity } from '../infrastructure/persistence/relational/entities/email-recipient.entity';
import type {
  AddRecipientDto,
  CreateRecipientListDto,
  UpdateRecipientDto,
  UpdateRecipientListDto,
} from '../dto/email-recipients.dto';

export interface RecipientListSummary {
  slug: string;
  name: string;
  description: string | null;
  system: boolean;
  active: boolean;
  /** People on the list who are switched on: the ones a mail would go to. */
  recipients: number;
}

export interface Recipient {
  id: string;
  email: string;
  name: string | null;
  active: boolean;
}

export interface RecipientListView extends RecipientListSummary {
  people: Recipient[];
}

const toSummary = (list: EmailRecipientListEntity, recipients: number): RecipientListSummary => ({
  slug: list.slug,
  name: list.name,
  description: list.description,
  system: list.system,
  active: list.active,
  recipients,
});

const toRecipient = (p: EmailRecipientEntity): Recipient => ({
  id: p.id,
  email: p.email,
  name: p.name,
  active: p.active,
});

/**
 * The master of who an email goes to. Code asks `resolve('some-slug')` for the addresses of a
 * list; staff keep the lists and the people on them. Any module can use it: add a list with a
 * slug, then ask for that slug where the mail is sent.
 */
@Injectable()
export class EmailRecipientsService {
  constructor(
    @InjectRepository(EmailRecipientListEntity)
    private readonly lists: Repository<EmailRecipientListEntity>,
    @InjectRepository(EmailRecipientEntity)
    private readonly people: Repository<EmailRecipientEntity>,
    private readonly audit: AuditService,
  ) {}

  /**
   * The addresses a mail for this slug goes to: the switched-on people of the list, when the list
   * itself is on. A list that does not exist, or is off, has nobody.
   */
  async resolve(slug: string): Promise<string[]> {
    const list = await this.lists.findOneBy({ slug, active: true });
    if (!list) return [];
    const rows = await this.people.find({
      where: { listSlug: slug, active: true },
      order: { createdAt: 'ASC' },
    });
    return [...new Set(rows.map((r) => r.email.trim().toLowerCase()))];
  }

  async list(): Promise<RecipientListSummary[]> {
    const [lists, active] = await Promise.all([
      this.lists.find({ order: { system: 'DESC', name: 'ASC' } }),
      this.people.find({ select: { listSlug: true }, where: { active: true } }),
    ]);
    return lists.map((l) => toSummary(l, active.filter((p) => p.listSlug === l.slug).length));
  }

  async one(slug: string): Promise<RecipientListView> {
    return this.view(slug);
  }

  async createList(dto: CreateRecipientListDto, user: SessionUser): Promise<RecipientListView> {
    if (await this.lists.findOneBy({ slug: dto.slug })) {
      throw new ConflictException(`A list with the slug "${dto.slug}" already exists.`);
    }
    await this.lists.save(
      this.lists.create({
        slug: dto.slug,
        name: dto.name,
        description: dto.description ?? null,
        system: false,
        active: true,
        createdBy: user.id,
      }),
    );
    await this.audit.record(user, {
      action: 'recipients.changed',
      detail: `List "${dto.slug}" created`,
    });
    return this.view(dto.slug);
  }

  async updateList(
    slug: string,
    dto: UpdateRecipientListDto,
    user: SessionUser,
  ): Promise<RecipientListView> {
    const list = await this.find(slug);
    const was = list.active;
    list.name = dto.name ?? list.name;
    if (dto.description !== undefined) list.description = dto.description;
    list.active = dto.active ?? list.active;
    await this.lists.save(list);
    if (list.active !== was) {
      await this.audit.record(user, {
        action: 'recipients.changed',
        detail: `List "${slug}" switched ${list.active ? 'on' : 'off'}`,
      });
    }
    return this.view(slug);
  }

  async deleteList(slug: string, user: SessionUser): Promise<void> {
    const list = await this.find(slug);
    if (list.system) {
      throw new BadRequestException(
        'The portal sends to this list itself, so it cannot be deleted. Switch it off instead.',
      );
    }
    await this.lists.delete({ slug });
    await this.audit.record(user, {
      action: 'recipients.changed',
      detail: `List "${slug}" deleted`,
    });
  }

  async addRecipient(
    slug: string,
    dto: AddRecipientDto,
    user: SessionUser,
  ): Promise<RecipientListView> {
    await this.find(slug);
    const email = dto.email.trim().toLowerCase();
    if (await this.people.findOneBy({ listSlug: slug, email })) {
      throw new ConflictException(`${email} is already on this list.`);
    }
    await this.people.save(
      this.people.create({
        listSlug: slug,
        email,
        name: dto.name ?? null,
        active: true,
        createdBy: user.id,
      }),
    );
    await this.audit.record(user, {
      action: 'recipients.changed',
      detail: `${email} added to "${slug}"`,
    });
    return this.view(slug);
  }

  async updateRecipient(
    slug: string,
    id: string,
    dto: UpdateRecipientDto,
    user: SessionUser,
  ): Promise<RecipientListView> {
    const person = await this.person(slug, id);
    const was = person.active;
    if (dto.name !== undefined) person.name = dto.name;
    person.active = dto.active ?? person.active;
    await this.people.save(person);
    if (person.active !== was) {
      await this.audit.record(user, {
        action: 'recipients.changed',
        detail: `${person.email} switched ${person.active ? 'on' : 'off'} on "${slug}"`,
      });
    }
    return this.view(slug);
  }

  async removeRecipient(slug: string, id: string, user: SessionUser): Promise<RecipientListView> {
    const person = await this.person(slug, id);
    await this.people.delete({ id });
    await this.audit.record(user, {
      action: 'recipients.changed',
      detail: `${person.email} removed from "${slug}"`,
    });
    return this.view(slug);
  }

  private async find(slug: string): Promise<EmailRecipientListEntity> {
    const list = await this.lists.findOneBy({ slug });
    if (!list) throw new NotFoundException('That list does not exist.');
    return list;
  }

  private async person(slug: string, id: string): Promise<EmailRecipientEntity> {
    const person = await this.people.findOneBy({ id, listSlug: slug });
    if (!person) throw new NotFoundException('That person is not on this list.');
    return person;
  }

  private async view(slug: string): Promise<RecipientListView> {
    const list = await this.find(slug);
    const rows = await this.people.find({ where: { listSlug: slug }, order: { createdAt: 'ASC' } });
    return {
      ...toSummary(list, rows.filter((p) => p.active).length),
      people: rows.map(toRecipient),
    };
  }
}
