import { SetMetadata } from '@nestjs/common';

export const CUSTOM_MESSAGE_KEY = 'customMessage';

/** The `header.msg` a successful response carries, instead of "Success". */
export const CustomMessage = (message: string) => SetMetadata(CUSTOM_MESSAGE_KEY, message);
