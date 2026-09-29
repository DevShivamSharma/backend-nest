import { IsOptional, IsString } from 'class-validator';

/**
 * Body of POST /api/planner-rules and PUT /api/planner-rules/:id.
 *
 * As on the layout path, the pipe checks TYPES only; the property is optional so that a
 * missing value reaches `validatePlannerRule`, which reports it in plain words.
 */
export class PlannerRuleRequestDto {
  @IsOptional()
  @IsString()
  description?: string | null;
}

export interface PlannerRuleResponse {
  id: number;
  description: string;
  createdAt: string;
  updatedAt: string;
}
