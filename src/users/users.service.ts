import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { UserEntity, UserStatus } from './user.entity';

export interface NewUser {
  email: string;
  name: string;
  passwordHash?: string | null;
  isPlatformAdmin?: boolean;
}

@Injectable()
export class UsersService {
  constructor(@InjectRepository(UserEntity) private readonly users: Repository<UserEntity>) {}

  static normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  findById(id: string): Promise<UserEntity | null> {
    return this.users.findOneBy({ id });
  }

  findActiveById(id: string): Promise<UserEntity | null> {
    return this.users.findOneBy({ id, status: UserStatus.Active });
  }

  findByEmail(email: string, manager?: EntityManager): Promise<UserEntity | null> {
    return this.repo(manager).findOneBy({ email: UsersService.normaliseEmail(email) });
  }

  /** The user with its password hash, which every other query leaves out. */
  findWithPasswordByEmail(email: string, manager?: EntityManager): Promise<UserEntity | null> {
    return this.repo(manager)
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email: UsersService.normaliseEmail(email) })
      .getOne();
  }

  create(input: NewUser, manager?: EntityManager): Promise<UserEntity> {
    const repo = this.repo(manager);
    return repo.save(
      repo.create({
        email: UsersService.normaliseEmail(input.email),
        name: input.name.trim(),
        passwordHash: input.passwordHash ?? null,
        isPlatformAdmin: input.isPlatformAdmin ?? false,
      }),
    );
  }

  async setPassword(
    userId: string,
    passwordHash: string,
    name?: string,
    manager?: EntityManager,
  ): Promise<void> {
    await this.repo(manager).update(
      { id: userId },
      name ? { passwordHash, name } : { passwordHash },
    );
  }

  async recordLogin(userId: string): Promise<void> {
    await this.users.update({ id: userId }, { lastLoginAt: new Date() });
  }

  private repo(manager?: EntityManager): Repository<UserEntity> {
    return manager ? manager.getRepository(UserEntity) : this.users;
  }
}
