import { Injectable } from '@nestjs/common';
import { BadRequestDomainError } from '../common/errors/domain.errors';
import type { PlannerRuleRequestDto, PlannerRuleResponse } from './planner-rule.dto';
import type { PlannerRuleEntity } from './planner-rule.entity';
import { PlannerRuleRepository } from './planner-rule.repository';
import { validatePlannerRule } from './planner-rule.validator';

/**
 * /api/planner-rules — the shared library of stall-plotting rules, in planners' own words.
 * Which rules apply is chosen per layout in the stall editor (`ruleIds` on the layout).
 * Not-found is a 400 with a plain message, as everywhere else in this API (ADR-003).
 */
@Injectable()
export class PlannerRuleService {
  constructor(private readonly rules: PlannerRuleRepository) {}

  async list(): Promise<PlannerRuleResponse[]> {
    return (await this.rules.list()).map(toResponse);
  }

  async get(id: number): Promise<PlannerRuleResponse> {
    const found = await this.rules.findById(id);
    if (found === null) throw notFound(id);
    return toResponse(found);
  }

  async create(request: PlannerRuleRequestDto): Promise<PlannerRuleResponse> {
    return toResponse(await this.rules.create(validatePlannerRule(request)));
  }

  async update(id: number, request: PlannerRuleRequestDto): Promise<PlannerRuleResponse> {
    const write = validatePlannerRule(request);
    const saved = await this.rules.replace(id, write);
    if (saved === null) throw notFound(id);
    return toResponse(saved);
  }

  async delete(id: number): Promise<void> {
    if (!(await this.rules.delete(id))) throw notFound(id);
  }
}

function notFound(id: number): BadRequestDomainError {
  return new BadRequestDomainError(`Rule not found: ${id}`);
}

function toResponse(rule: PlannerRuleEntity): PlannerRuleResponse {
  return {
    id: rule.id,
    description: rule.description,
    createdAt: new Date(rule.createdAt).toISOString(),
    updatedAt: new Date(rule.updatedAt).toISOString(),
  };
}
