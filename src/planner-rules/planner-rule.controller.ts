import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import { PlannerRuleRequestDto, PlannerRuleResponse } from './planner-rule.dto';
import { PlannerRuleService } from './planner-rule.service';

/** /api/planner-rules/** — thin: no logic here. */
@Controller('planner-rules')
export class PlannerRuleController {
  constructor(private readonly service: PlannerRuleService) {}

  @Get()
  list(): Promise<PlannerRuleResponse[]> {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): Promise<PlannerRuleResponse> {
    return this.service.get(id);
  }

  @Post()
  create(@Body() request: PlannerRuleRequestDto): Promise<PlannerRuleResponse> {
    return this.service.create(request);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() request: PlannerRuleRequestDto,
  ): Promise<PlannerRuleResponse> {
    return this.service.update(id, request);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.service.delete(id);
  }
}
