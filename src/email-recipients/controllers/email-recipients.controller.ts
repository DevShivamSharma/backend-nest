import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { AllowedUserTypes } from '../../auth/decorators/user-types.decorator';
import type { SessionUser } from '../../auth/domain/session-user';
import { UserType } from '../../auth/domain/user-type';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  AddRecipientDto,
  CreateRecipientListDto,
  UpdateRecipientDto,
  UpdateRecipientListDto,
} from '../dto/email-recipients.dto';
import {
  EmailRecipientsService,
  RecipientListSummary,
  RecipientListView,
} from '../services/email-recipients.service';

/** Who each email goes to, kept by ITPO staff. */
@AllowedUserTypes(UserType.ItpoStaff)
@Controller({ path: 'email-recipients', version: '1' })
export class EmailRecipientsController {
  constructor(private readonly recipients: EmailRecipientsService) {}

  @Get()
  lists(): Promise<RecipientListSummary[]> {
    return this.recipients.list();
  }

  @Post()
  create(
    @Body() dto: CreateRecipientListDto,
    @CurrentUser() user: SessionUser,
  ): Promise<RecipientListView> {
    return this.recipients.createList(dto, user);
  }

  @Get(':slug')
  one(@Param('slug') slug: string): Promise<RecipientListView> {
    return this.recipients.one(slug);
  }

  @Patch(':slug')
  update(
    @Param('slug') slug: string,
    @Body() dto: UpdateRecipientListDto,
    @CurrentUser() user: SessionUser,
  ): Promise<RecipientListView> {
    return this.recipients.updateList(slug, dto, user);
  }

  @Delete(':slug')
  @HttpCode(200)
  async remove(@Param('slug') slug: string, @CurrentUser() user: SessionUser): Promise<null> {
    await this.recipients.deleteList(slug, user);
    return null;
  }

  @Post(':slug/people')
  add(
    @Param('slug') slug: string,
    @Body() dto: AddRecipientDto,
    @CurrentUser() user: SessionUser,
  ): Promise<RecipientListView> {
    return this.recipients.addRecipient(slug, dto, user);
  }

  @Patch(':slug/people/:id')
  updatePerson(
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRecipientDto,
    @CurrentUser() user: SessionUser,
  ): Promise<RecipientListView> {
    return this.recipients.updateRecipient(slug, id, dto, user);
  }

  @Delete(':slug/people/:id')
  removePerson(
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<RecipientListView> {
    return this.recipients.removeRecipient(slug, id, user);
  }
}
