import { Body, Controller, Delete, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';

import { UserType } from '../../auth/domain/user-type';
import { AllowedUserTypes } from '../../auth/decorators/user-types.decorator';
import type { SessionUser } from '../../auth/domain/session-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateHallDto, HallImageDto } from '../dto/create-hall.dto';
import { CreatedHall, HallImage, HallsService } from '../services/halls.service';

@Controller({ path: 'halls', version: '1' })
export class HallsController {
  constructor(private readonly halls: HallsService) {}

  /** Draw by size: ITPO staff make a hall from a length and breadth, with an optional outline. */
  @AllowedUserTypes(UserType.ItpoStaff)
  @Post()
  create(@Body() dto: CreateHallDto, @CurrentUser() user: SessionUser): Promise<CreatedHall> {
    return this.halls.create(dto, user.id);
  }

  /** Adds a picture to a hall, by its URL. */
  @AllowedUserTypes(UserType.ItpoStaff)
  @Post(':hallId/images')
  addImage(
    @Param('hallId', ParseIntPipe) hallId: number,
    @Body() dto: HallImageDto,
  ): Promise<HallImage> {
    return this.halls.addImage(hallId, dto);
  }

  /** Takes a picture off a hall. */
  @AllowedUserTypes(UserType.ItpoStaff)
  @Delete(':hallId/images/:documentId')
  @HttpCode(200)
  async removeImage(
    @Param('hallId', ParseIntPipe) hallId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
  ): Promise<null> {
    await this.halls.removeImage(hallId, documentId);
    return null;
  }
}
