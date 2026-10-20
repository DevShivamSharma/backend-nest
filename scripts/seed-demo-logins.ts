import 'reflect-metadata';

import * as argon2 from 'argon2';
import type { EntityManager } from 'typeorm';

import dataSource from '../src/database/data-source';
import { MembershipEntity } from '../src/access/membership.entity';
import type { MembershipScope } from '../src/access/membership-scope';
import { EventEntity } from '../src/events/event.entity';
import { EventExhibitorEntity, ExhibitorEntity } from '../src/exhibitors/exhibitor.entity';
import {
  BookingMode,
  DEFAULT_FEATURES,
  DEFAULT_LIMITS,
  defaultConfig,
} from '../src/organisations/organisation-config';
import { OrganisationConfigVersionEntity } from '../src/organisations/organisation-config-version.entity';
import { OrganisationEntity, OrganisationStatus } from '../src/organisations/organisation.entity';
import { RoleEntity, RoleScopeKind } from '../src/roles/role.entity';
import { UserEntity } from '../src/users/user.entity';

/**
 * Local development only: a demo venue organisation with one event and one test account per
 * platform role, all with the same dummy password. Safe to run again; it updates what exists.
 * Put the emails in DEV_LOGIN_EMAILS to get a one-click card for each on the page at /.
 *
 *   npm run demo:seed
 */
const DEMO_PASSWORD = 'Demo@12345';
const ORG = { slug: 'demo-venue', name: 'Demo Venue' };
const EVENT_NAME = 'Demo Expo 2026';
const EXHIBITOR_NAME = 'Demo Exhibitor Pvt Ltd';

const SUPER_ADMIN = { email: 'super-admin@demo.test', name: 'Demo Super Admin' };
const ACCOUNTS = [
  { email: 'venue-admin@demo.test', name: 'Demo Venue Admin', roleKey: 'venue_admin' },
  { email: 'venue-architect@demo.test', name: 'Demo Venue Architect', roleKey: 'venue_architect' },
  { email: 'organiser-admin@demo.test', name: 'Demo Organiser Admin', roleKey: 'organiser_admin' },
  {
    email: 'organiser-architect@demo.test',
    name: 'Demo Organiser Architect',
    roleKey: 'organiser_architect',
  },
  { email: 'exhibitor@demo.test', name: 'Demo Exhibitor', roleKey: 'exhibitor' },
] as const;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demo accounts with NODE_ENV=production.');
  }

  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'each' });
    const passwordHash = await argon2.hash(DEMO_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    await dataSource.transaction(async (em) => {
      await upsertUser(em, SUPER_ADMIN.email, SUPER_ADMIN.name, passwordHash, true);
      const organisation = await upsertOrganisation(em);
      const event = await upsertEvent(em, organisation.id);
      const exhibitor = await upsertExhibitor(em, organisation.id, event.id);

      for (const account of ACCOUNTS) {
        const user = await upsertUser(em, account.email, account.name, passwordHash, false);
        const role = await em.getRepository(RoleEntity).findOneByOrFail({ key: account.roleKey });
        const scope: MembershipScope =
          role.scopeKind === RoleScopeKind.Event
            ? {
                eventIds: [event.id],
                ...(account.roleKey === 'exhibitor' ? { exhibitorId: exhibitor.id } : {}),
              }
            : {};
        const memberships = em.getRepository(MembershipEntity);
        const existing = await memberships.findOneBy({
          userId: user.id,
          organisationId: organisation.id,
        });
        if (existing) {
          await memberships.update({ id: existing.id }, { roleId: role.id, scope });
        } else {
          await memberships.insert({
            userId: user.id,
            organisationId: organisation.id,
            roleId: role.id,
            scope,
          });
        }
      }
    });

    console.log(`Seeded ${ORG.name} (/${ORG.slug}) with "${EVENT_NAME}". Password for all:`);
    console.log(`  ${DEMO_PASSWORD}`);
    console.log(`  ${SUPER_ADMIN.email}  (Super Admin, /admin/login)`);
    for (const account of ACCOUNTS) console.log(`  ${account.email}  (${account.roleKey})`);
    console.log('DEV_LOGIN_EMAILS=' + ACCOUNTS.map((a) => a.email).join(','));
  } finally {
    await dataSource.destroy();
  }
}

async function upsertUser(
  em: EntityManager,
  email: string,
  name: string,
  passwordHash: string,
  isPlatformAdmin: boolean,
): Promise<UserEntity> {
  const users = em.getRepository(UserEntity);
  const existing = await users.findOneBy({ email });
  if (existing) {
    await users.update({ id: existing.id }, { name, passwordHash, isPlatformAdmin });
    return users.findOneByOrFail({ id: existing.id });
  }
  return users.save(users.create({ email, name, passwordHash, isPlatformAdmin }));
}

async function upsertOrganisation(em: EntityManager): Promise<OrganisationEntity> {
  const repo = em.getRepository(OrganisationEntity);
  const existing = await repo.findOneBy({ slug: ORG.slug });
  if (existing) return existing;

  const config = defaultConfig(ORG.name);
  const organisation = await repo.save(
    repo.create({
      slug: ORG.slug,
      name: ORG.name,
      status: OrganisationStatus.Active,
      bookingMode: BookingMode.OwnPortal,
      platformFeePercent: 0,
      features: { ...DEFAULT_FEATURES },
      limits: { ...DEFAULT_LIMITS },
      config,
      configVersion: 1,
    }),
  );
  await em.getRepository(OrganisationConfigVersionEntity).insert({
    organisationId: organisation.id,
    version: 1,
    config,
    changedById: null,
  });
  return organisation;
}

async function upsertEvent(em: EntityManager, organisationId: string): Promise<EventEntity> {
  const repo = em.getRepository(EventEntity);
  const existing = await repo.findOneBy({ organisationId, name: EVENT_NAME });
  if (existing) return existing;
  return repo.save(
    repo.create({
      organisationId,
      kind: 'external',
      status: 'draft',
      bookingChannel: 'platform_portal',
      name: EVENT_NAME,
      organiserName: 'Demo Organiser',
      audience: 'B2B',
      startsOn: '2026-12-10',
      endsOn: '2026-12-13',
    }),
  );
}

async function upsertExhibitor(
  em: EntityManager,
  organisationId: string,
  eventId: string,
): Promise<ExhibitorEntity> {
  const repo = em.getRepository(ExhibitorEntity);
  const exhibitor =
    (await repo.findOneBy({ organisationId, name: EXHIBITOR_NAME })) ??
    (await repo.save(
      repo.create({
        organisationId,
        name: EXHIBITOR_NAME,
        contactName: 'Demo Exhibitor',
        email: 'exhibitor@demo.test',
      }),
    ));
  await em
    .getRepository(EventExhibitorEntity)
    .createQueryBuilder()
    .insert()
    .values({ eventId, exhibitorId: exhibitor.id })
    .orIgnore()
    .execute();
  return exhibitor;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
