import { BadRequestDomainError } from '../common/errors/domain.errors';
import type { PlannerRuleRequestDto } from './planner-rule.dto';

export const MAX_RULE_LENGTH = 2000;

/** A validated rule, ready to be written. */
export interface PlannerRuleWrite {
  description: string;
}

/** Business validation for a rule. Pure. */
export function validatePlannerRule(request: PlannerRuleRequestDto | null | undefined): PlannerRuleWrite {
  if (request == null) {
    throw new BadRequestDomainError('Request body is required.');
  }
  const description = (request.description ?? '').trim();
  if (!description) {
    throw new BadRequestDomainError('Describe the rule.');
  }
  if (description.length > MAX_RULE_LENGTH) {
    throw new BadRequestDomainError(
      `The rule is too long: ${description.length} characters. Maximum is ${MAX_RULE_LENGTH}.`,
    );
  }
  return { description };
}
