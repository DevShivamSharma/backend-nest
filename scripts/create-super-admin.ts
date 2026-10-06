import 'reflect-metadata';

import * as argon2 from 'argon2';

import dataSource from '../src/database/data-source';
import { PASSWORD_MIN } from '../src/common/validation';
import { UserEntity } from '../src/users/user.entity';

/**
 * Creates the platform's Super Admin, or resets an existing one's password and flag.
 * Reads SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD and SUPER_ADMIN_NAME from the environment, so
 * the password never appears in shell history or the process list.
 *
 *   npm run admin:create
 */
async function main(): Promise<void> {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  const name = process.env.SUPER_ADMIN_NAME?.trim() || 'Platform Admin';

  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error('Set SUPER_ADMIN_EMAIL to the Super Admin email address.');
  }
  if (!password || password.length < PASSWORD_MIN) {
    throw new Error(`Set SUPER_ADMIN_PASSWORD to at least ${PASSWORD_MIN} characters.`);
  }

  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'each' });
    const users = dataSource.getRepository(UserEntity);
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const existing = await users.findOneBy({ email });
    if (existing) {
      await users.update({ id: existing.id }, { passwordHash, isPlatformAdmin: true, name });
      console.log(`Updated the Super Admin ${email}.`);
    } else {
      await users.insert({ email, name, passwordHash, isPlatformAdmin: true });
      console.log(`Created the Super Admin ${email}.`);
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
