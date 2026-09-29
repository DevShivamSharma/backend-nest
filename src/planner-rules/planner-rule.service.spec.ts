import { BadRequestDomainError } from '../common/errors/domain.errors';
import type { PlannerRuleEntity } from './planner-rule.entity';
import { PlannerRuleRepository } from './planner-rule.repository';
import { PlannerRuleService } from './planner-rule.service';
import { MAX_RULE_LENGTH, PlannerRuleWrite, validatePlannerRule } from './planner-rule.validator';

describe('validatePlannerRule', () => {
  const message = (request: unknown): string => {
    try {
      validatePlannerRule(request as never);
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestDomainError);
      return (error as Error).message;
    }
    throw new Error('expected validatePlannerRule to throw');
  };

  it('trims the text', () => {
    expect(validatePlannerRule({ description: '  Keep 3 m aisles  ' })).toEqual({ description: 'Keep 3 m aisles' });
  });

  it.each([[null], [undefined]])('requires a body: %p', (body) => {
    expect(message(body)).toBe('Request body is required.');
  });

  it.each([[''], ['   '], [null], [undefined]])('requires a description: %p', (description) => {
    expect(message({ description })).toBe('Describe the rule.');
  });

  it('limits the length', () => {
    expect(message({ description: 'a'.repeat(MAX_RULE_LENGTH + 1) })).toMatch(/too long/);
  });
});

describe('PlannerRuleService', () => {
  const entity = (write: PlannerRuleWrite, id = 1000): PlannerRuleEntity => ({
    id,
    description: write.description,
    createdAt: new Date('2026-09-28T10:00:00Z'),
    updatedAt: new Date('2026-09-28T10:00:00Z'),
  });

  function setup() {
    const repo = {
      list: jest.fn(async () => [] as PlannerRuleEntity[]),
      findById: jest.fn(async () => null as PlannerRuleEntity | null),
      create: jest.fn(async (w: PlannerRuleWrite) => entity(w)),
      replace: jest.fn(async (id: number, w: PlannerRuleWrite) => entity(w, id) as PlannerRuleEntity | null),
      delete: jest.fn(async () => true),
    };
    return { repo, service: new PlannerRuleService(repo as unknown as PlannerRuleRepository) };
  }

  it('creates a rule', async () => {
    const { repo, service } = setup();
    const created = await service.create({ description: 'No stalls near exits' });
    expect(repo.create).toHaveBeenCalledWith({ description: 'No stalls near exits' });
    expect(created).toEqual({
      id: 1000,
      description: 'No stalls near exits',
      createdAt: '2026-09-28T10:00:00.000Z',
      updatedAt: '2026-09-28T10:00:00.000Z',
    });
  });

  it('validates before looking the rule up on update', async () => {
    const { repo, service } = setup();
    await expect(service.update(1, { description: '' })).rejects.toThrow('Describe the rule.');
    expect(repo.replace).not.toHaveBeenCalled();
  });

  it('reports a missing rule', async () => {
    const { repo, service } = setup();
    repo.replace.mockResolvedValueOnce(null);
    await expect(service.update(7, { description: 'x' })).rejects.toThrow('Rule not found: 7');
    repo.delete.mockResolvedValueOnce(false);
    await expect(service.delete(7)).rejects.toThrow('Rule not found: 7');
    await expect(service.get(7)).rejects.toThrow('Rule not found: 7');
  });
});
