import 'reflect-metadata';

import * as bcrypt from 'bcryptjs';

import dataSource from '../src/database/data-source';
import { PASSWORD_MIN } from '../src/common/validation';

/**
 * Creates ITPO's Super Admin in ITPO's own users (T_USER, its profile and the `system_admin`
 * role in T_USERS_ROLES), as SelfCare's admins are kept, or resets an existing one's password
 * and role. It signs in here (AUTH_SOURCE=itpo) and in SelfCare alike.
 * Reads ITPO_SUPER_ADMIN_EMAIL, ITPO_SUPER_ADMIN_PASSWORD and ITPO_SUPER_ADMIN_NAME from the
 * environment, so the password never appears in shell history or the process list.
 *
 *   npm run itpo-admin:create
 */
const ROLE = 'system_admin';

async function main(): Promise<void> {
  const email = process.env.ITPO_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ITPO_SUPER_ADMIN_PASSWORD;
  const name = process.env.ITPO_SUPER_ADMIN_NAME?.trim() || 'ITPO Super Admin';

  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error('Set ITPO_SUPER_ADMIN_EMAIL to the Super Admin email address.');
  }
  if (!password || password.length < PASSWORD_MIN) {
    throw new Error(`Set ITPO_SUPER_ADMIN_PASSWORD to at least ${PASSWORD_MIN} characters.`);
  }

  await dataSource.initialize();
  try {
    // ITPO's users are bcrypt-hashed, as itpo_user checks them.
    const hash = await bcrypt.hash(password, 10);
    await dataSource.transaction(async (em) => {
      const [role] = await em.query(`SELECT id FROM idp."T_CODE_MASTER" WHERE slug = $1`, [ROLE]);
      if (!role) throw new Error(`ITPO has no "${ROLE}" role in T_CODE_MASTER.`);

      const [existing] = await em.query(
        `SELECT id FROM idp."T_USER" WHERE lower(email) = $1 AND "deletedAt" IS NULL`,
        [email],
      );
      let id: string;
      if (existing) {
        id = existing.id;
        await em.query(
          `UPDATE idp."T_USER" SET password = $1, "isActive" = true, "updatedAt" = now() WHERE id = $2`,
          [hash, id],
        );
        console.log(`Updated ITPO's Super Admin ${email}.`);
      } else {
        [{ id }] = await em.query(
          `INSERT INTO idp."T_USER"
             (username, email, password, "isActive", "isEmailVerified", "isProfileComplete", source)
           VALUES ($1, $2, $3, true, true, true, 'venue-planner')
           RETURNING id`,
          [email, email, hash],
        );
        await em.query(`INSERT INTO idp."T_USER_PROFILE" (name, user_id) VALUES ($1, $2)`, [
          name,
          id,
        ]);
        console.log(`Created ITPO's Super Admin ${email}.`);
      }
      await em.query(
        `INSERT INTO idp."T_USERS_ROLES" (user_id, role_id)
         SELECT $1, $2 WHERE NOT EXISTS (
           SELECT 1 FROM idp."T_USERS_ROLES" WHERE user_id = $1 AND role_id = $2
         )`,
        [id, role.id],
      );
    });
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
