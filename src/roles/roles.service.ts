import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/http/authenticated-request';
import { OrganisationEntity } from '../organisations/organisation.entity';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { ALL_PERMISSIONS, holdsAll, normalisePermissions, Permission } from './permissions';
import { OWNER_ROLE_KEY, RoleEntity, RoleScopeKind } from './role.entity';
import type { AdminRoleView, AssignableRoleView, RoleRef, RoleView } from './role.views';

/** Owner first, then whole-organisation roles before event roles, platform before custom. */
const ROLE_ORDER = {
  isLocked: 'DESC',
  scopeKind: 'DESC',
  isSystem: 'DESC',
  name: 'ASC',
} as const;

interface RoleUsage {
  memberCount: number;
  openInvitationCount: number;
}

/**
 * Roles are data the Super Admin defines; permissions are the fixed catalogue the code checks.
 * This service owns the rules between the two.
 */
@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(RoleEntity) private readonly roles: Repository<RoleEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** The locked owner role holds every permission, including ones added to the catalogue later. */
  static effectivePermissions(role: RoleEntity): Permission[] {
    return role.isLocked ? [...ALL_PERMISSIONS] : normalisePermissions(role.permissions);
  }

  static ref(role: RoleEntity): RoleRef {
    return { id: role.id, key: role.key, name: role.name };
  }

  /**
   * Whether a member holding `granterPermissions` may give `role`: never more than they hold,
   * and event roles only once events exist (`hasEvents`).
   */
  static grantCheck(
    granterPermissions: readonly string[],
    role: RoleEntity,
    hasEvents = false,
  ): string | null {
    if (role.scopeKind === RoleScopeKind.Event && !hasEvents) {
      return 'Event roles can be given once the event exists.';
    }
    if (!holdsAll(granterPermissions, RolesService.effectivePermissions(role))) {
      return 'This role has permissions you do not have.';
    }
    return null;
  }

  async getOwnerRole(manager?: EntityManager): Promise<RoleEntity> {
    const repo = manager ? manager.getRepository(RoleEntity) : this.roles;
    const role = await repo.findOneBy({ key: OWNER_ROLE_KEY, organisationId: IsNull() });
    if (!role) {
      throw new Error(`The system role "${OWNER_ROLE_KEY}" is missing; run the migrations.`);
    }
    return role;
  }

  /** A role the organisation can use: platform-wide or its own. 404 for anything else. */
  async getForOrganisation(organisationId: string, roleId: string): Promise<RoleEntity> {
    const role = await this.roles.findOne({
      where: [
        { id: roleId, organisationId: IsNull() },
        { id: roleId, organisationId },
      ],
    });
    if (!role) {
      throw new NotFoundException('Role not found.');
    }
    return role;
  }

  /**
   * The roles the organisation can use, and which of them the granter may give. An
   * event-scoped granter (`eventScoped`) gives event roles only.
   */
  async listForOrganisation(
    organisation: OrganisationEntity,
    granterPermissions: readonly string[],
    options: { hasEvents?: boolean; eventScoped?: boolean } = {},
  ): Promise<AssignableRoleView[]> {
    const roles = await this.roles.find({
      where: [{ organisationId: IsNull() }, { organisationId: organisation.id }],
      relations: { organisation: true },
      order: ROLE_ORDER,
    });

    return roles.map((role) => {
      const reason =
        options.eventScoped && role.scopeKind !== RoleScopeKind.Event
          ? 'You can give only event roles, for your own events.'
          : RolesService.grantCheck(granterPermissions, role, options.hasEvents ?? false);
      return { ...RolesService.view(role), assignable: reason === null, reason };
    });
  }

  async listForAdmin(organisationId?: string): Promise<AdminRoleView[]> {
    const roles = await this.roles.find({
      where: organisationId ? [{ organisationId: IsNull() }, { organisationId }] : undefined,
      relations: { organisation: true },
      order: ROLE_ORDER,
    });
    const usage = await this.usage(roles.map((role) => role.id));

    return roles.map((role) => ({
      ...RolesService.view(role),
      ...(usage.get(role.id) ?? { memberCount: 0, openInvitationCount: 0 }),
    }));
  }

  async getForAdmin(id: string): Promise<AdminRoleView> {
    const role = await this.findOrFail(id);
    const usage = await this.usage([id]);
    return {
      ...RolesService.view(role),
      ...(usage.get(id) ?? { memberCount: 0, openInvitationCount: 0 }),
    };
  }

  async create(dto: CreateRoleDto, actor: Actor): Promise<AdminRoleView> {
    const id = await this.dataSource.transaction(async (manager) => {
      if (dto.organisationId) {
        const exists = await manager.getRepository(OrganisationEntity).existsBy({
          id: dto.organisationId,
        });
        if (!exists) {
          throw new NotFoundException('Organisation not found.');
        }
      }
      await this.assertKeyFree(manager, dto.key, dto.organisationId ?? null);

      const role = await manager.getRepository(RoleEntity).save(
        manager.getRepository(RoleEntity).create({
          organisationId: dto.organisationId ?? null,
          key: dto.key,
          name: dto.name,
          description: dto.description ?? null,
          scopeKind: dto.scopeKind,
          permissions: normalisePermissions(dto.permissions),
        }),
      );

      await this.audit.record(
        {
          action: 'role.created',
          actor,
          organisationId: role.organisationId,
          targetType: 'role',
          targetId: role.id,
          metadata: { key: role.key, permissions: role.permissions },
        },
        manager,
      );
      return role.id;
    });

    return this.getForAdmin(id);
  }

  async update(id: string, dto: UpdateRoleDto, actor: Actor): Promise<AdminRoleView> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(RoleEntity);
      const role = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!role) {
        throw new NotFoundException('Role not found.');
      }
      if (role.isLocked && (dto.permissions || dto.scopeKind)) {
        throw new ConflictException(
          `${role.name} always holds every permission, so it cannot be changed.`,
        );
      }

      const before = { name: role.name, scopeKind: role.scopeKind, permissions: role.permissions };

      if (dto.scopeKind && dto.scopeKind !== role.scopeKind) {
        const usage = (await this.usage([role.id], manager)).get(role.id);
        if (usage && usage.memberCount + usage.openInvitationCount > 0) {
          throw new ConflictException(
            'The scope of a role in use cannot change. Create a new role instead.',
          );
        }
        role.scopeKind = dto.scopeKind;
      }
      if (dto.name !== undefined) {
        role.name = dto.name;
      }
      if (dto.description !== undefined) {
        role.description = dto.description ?? null;
      }
      if (dto.permissions) {
        role.permissions = normalisePermissions(dto.permissions);
      }

      await repo.save(role);
      await this.audit.record(
        {
          action: 'role.updated',
          actor,
          organisationId: role.organisationId,
          targetType: 'role',
          targetId: role.id,
          metadata: {
            key: role.key,
            before,
            after: { name: role.name, scopeKind: role.scopeKind, permissions: role.permissions },
          },
        },
        manager,
      );
    });

    return this.getForAdmin(id);
  }

  async remove(id: string, actor: Actor): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(RoleEntity);
      const role = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!role) {
        throw new NotFoundException('Role not found.');
      }
      if (role.isSystem) {
        throw new ConflictException(
          'A system role cannot be deleted. Change its permissions instead.',
        );
      }
      const usage = (await this.usage([role.id], manager)).get(role.id);
      if (usage && usage.memberCount + usage.openInvitationCount > 0) {
        throw new ConflictException(
          `${usage.memberCount} member(s) and ${usage.openInvitationCount} open invitation(s) ` +
            'use this role. Move them to another role first.',
        );
      }

      await repo.delete({ id });
      await this.audit.record(
        {
          action: 'role.deleted',
          actor,
          organisationId: role.organisationId,
          targetType: 'role',
          targetId: role.id,
          metadata: { key: role.key, name: role.name },
        },
        manager,
      );
    });
  }

  private async findOrFail(id: string): Promise<RoleEntity> {
    const role = await this.roles.findOne({ where: { id }, relations: { organisation: true } });
    if (!role) {
      throw new NotFoundException('Role not found.');
    }
    return role;
  }

  /**
   * A key must be unambiguous wherever the role is visible: a platform key clashes with every
   * organisation's own keys, an organisation key with the platform's and its own.
   */
  private async assertKeyFree(
    manager: EntityManager,
    key: string,
    organisationId: string | null,
  ): Promise<void> {
    const repo = manager.getRepository(RoleEntity);
    const clash = organisationId
      ? await repo.existsBy([
          { key, organisationId: IsNull() },
          { key, organisationId },
        ])
      : await repo.existsBy({ key });
    if (clash) {
      throw new ConflictException(`A role with the key "${key}" already exists.`);
    }
  }

  private async usage(roleIds: string[], manager?: EntityManager): Promise<Map<string, RoleUsage>> {
    const result = new Map<string, RoleUsage>();
    if (roleIds.length === 0) {
      return result;
    }
    const rows: Array<{ role_id: string; members: number; invitations: number }> = await (
      manager ?? this.dataSource
    ).query(
      `SELECT r.id AS role_id,
              (SELECT count(*) FROM memberships m WHERE m.role_id = r.id) AS members,
              (SELECT count(*) FROM invitations i
                 WHERE i.role_id = r.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL
                   AND i.expires_at > now()) AS invitations
         FROM roles r
        WHERE r.id = ANY($1::uuid[])`,
      [roleIds],
    );
    for (const row of rows) {
      result.set(row.role_id, {
        memberCount: Number(row.members),
        openInvitationCount: Number(row.invitations),
      });
    }
    return result;
  }

  static view(role: RoleEntity): RoleView {
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      scopeKind: role.scopeKind,
      permissions: RolesService.effectivePermissions(role),
      isSystem: role.isSystem,
      isLocked: role.isLocked,
      organisation: role.organisation
        ? { id: role.organisation.id, slug: role.organisation.slug, name: role.organisation.name }
        : null,
    };
  }
}
