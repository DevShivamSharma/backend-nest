import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import {
  ExternalRefEntity,
  type ExternalEntityType,
  type ExternalSystem,
} from './external-ref.entity';

/**
 * Links one of our records to its id in a venue system, or unlinks it (`externalId` null).
 * Both directions are unique per organisation, system and type (`external_refs` constraints),
 * so an id already linked to another record is refused in words instead of failing on the
 * constraint. Returns whether anything changed, for the caller's audit entry.
 */
export async function setExternalId(
  em: EntityManager,
  ref: {
    organisationId: string;
    system: ExternalSystem;
    entityType: ExternalEntityType;
    localId: string;
  },
  externalId: string | null,
): Promise<boolean> {
  const repo = em.getRepository(ExternalRefEntity);
  const { organisationId, system, entityType, localId } = ref;
  const existing = await repo.findOneBy({ organisationId, system, entityType, localId });
  if (externalId === null) {
    if (!existing) return false;
    await repo.delete({ id: existing.id });
    return true;
  }
  if (existing?.externalId === externalId) return false;
  const taken = await repo.findOneBy({ organisationId, system, entityType, externalId });
  if (taken && taken.localId !== localId) {
    throw new ConflictException(
      `SelfCare ${entityType} ${externalId} is already linked to another ${entityType}.`,
    );
  }
  if (existing) {
    await repo.update({ id: existing.id }, { externalId });
  } else {
    await repo.insert({ organisationId, system, entityType, localId, externalId });
  }
  return true;
}