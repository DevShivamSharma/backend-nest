import { SetMetadata } from '@nestjs/common';

import type { UserType } from '../domain/user-type';

export const ALLOWED_USER_TYPES_KEY = 'allowedUserTypes';

/** Limits a route to the given kinds of user; any signed-in user may use a route without it. */
export const AllowedUserTypes = (...types: UserType[]) =>
  SetMetadata(ALLOWED_USER_TYPES_KEY, types);
