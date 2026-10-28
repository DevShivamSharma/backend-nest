import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';

import type { SessionUser } from '../../auth/domain/session-user';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import {
  MAX_PROOF_BYTES,
  MAX_PROOF_FILES,
  proofFiles,
  type UploadedProof,
} from '../domain/proof-files';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CheckPlanDto, PublishPlanDto, RejectPlanDto, SavePlanDto } from '../dto/stall-plans.dto';
import {
  HallPlanStatus,
  PlannerView,
  StallPlansService,
  StallPlanView,
} from '../services/stall-plans.service';

/**
 * The stall plan of an event's hall. Any signed-in user may open it (an organiser only their own
 * organisation's events); what they may do with it is in the answer, and checked again on each call.
 */
@Controller({ path: 'events/:eventId/halls/:eventHallId/plan', version: '1' })
export class StallPlansController {
  constructor(private readonly plans: StallPlansService) {}

  @Get()
  get(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<PlannerView> {
    return this.plans.get(eventId, eventHallId, user);
  }

  @Post('check')
  @HttpCode(200)
  check(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @Body() dto: CheckPlanDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.plans.check(eventId, eventHallId, dto, user);
  }

  @Put()
  save(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @Body() dto: SavePlanDto,
    @CurrentUser() user: SessionUser,
  ): Promise<StallPlanView> {
    return this.plans.save(eventId, eventHallId, dto, user);
  }

  @Post('publish')
  @HttpCode(200)
  publish(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @Body() dto: PublishPlanDto,
    @CurrentUser() user: SessionUser,
  ): Promise<StallPlanView> {
    return this.plans.publish(eventId, eventHallId, dto, user);
  }

  @Post('submit')
  @HttpCode(200)
  submit(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @Body() dto: PublishPlanDto,
    @CurrentUser() user: SessionUser,
  ): Promise<StallPlanView> {
    return this.plans.submit(eventId, eventHallId, dto, user);
  }

  @Post('withdraw')
  @HttpCode(200)
  withdraw(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<StallPlanView> {
    return this.plans.withdraw(eventId, eventHallId, user);
  }

  @Post('approve')
  @HttpCode(200)
  approve(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @Body() dto: PublishPlanDto,
    @CurrentUser() user: SessionUser,
  ): Promise<StallPlanView> {
    return this.plans.review(eventId, eventHallId, dto, true, user);
  }

  /** Sends the plan back with a note, and maybe proof (images and PDF) as multipart `files`. */
  /** Sends the plan back. A form with the files as proof, or plain JSON with only the note. */
  @Post('reject')
  @HttpCode(200)
  @UseInterceptors(
    FilesInterceptor('files', MAX_PROOF_FILES, { limits: { fileSize: MAX_PROOF_BYTES } }),
  )
  reject(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @Body() dto: RejectPlanDto,
    @UploadedFiles() files: UploadedProof[] | undefined,
    @CurrentUser() user: SessionUser,
  ): Promise<StallPlanView> {
    const proof = proofFiles(files);
    if (proof.problems.length) throw new BadRequestException(proof.problems.join(' '));
    return this.plans.review(eventId, eventHallId, dto, false, user, proof.files);
  }

  /** ITPO takes an approved hall back to Draft. */
  @Post('reopen')
  @HttpCode(200)
  reopen(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<StallPlanView> {
    return this.plans.reopen(eventId, eventHallId, user);
  }

  /** A proof file of a rejection, as a download. */
  @RawResponse()
  @Get('attachments/:attachmentId')
  @Header('X-Content-Type-Options', 'nosniff')
  async attachment(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('eventHallId', ParseUUIDPipe) eventHallId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<StreamableFile> {
    const file = await this.plans.attachment(eventId, eventHallId, attachmentId, user);
    return new StreamableFile(file.data, {
      type: file.mimeType,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
  }
}

/** Where the plans of an event's halls stand, and how many wait for ITPO. */
@Controller({ version: '1' })
export class PlanOverviewController {
  constructor(private readonly plans: StallPlansService) {}

  @Get('events/:eventId/plan-statuses')
  statuses(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<HallPlanStatus[]> {
    return this.plans.statuses(eventId, user);
  }

  @Get('plan-reviews/pending-count')
  async pending(@CurrentUser() user: SessionUser): Promise<{ count: number }> {
    return { count: await this.plans.pendingCount(user) };
  }
}
