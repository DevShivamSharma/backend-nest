import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PlannerRuleEntity } from './planner-rule.entity';
import type { PlannerRuleWrite } from './planner-rule.validator';

/** All persistence for planner rules. No business rules here. */
@Injectable()
export class PlannerRuleRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Every rule, oldest first: the order they were written in is the order they are read. */
  list(): Promise<PlannerRuleEntity[]> {
    return this.dataSource.getRepository(PlannerRuleEntity).find({ order: { id: 'ASC' } });
  }

  findById(id: number): Promise<PlannerRuleEntity | null> {
    return this.dataSource.getRepository(PlannerRuleEntity).findOneBy({ id });
  }

  async create(write: PlannerRuleWrite): Promise<PlannerRuleEntity> {
    const rules = this.dataSource.getRepository(PlannerRuleEntity);
    const rule = await rules.save(rules.create({ description: write.description }));
    // Re-read so the database defaults (timestamps) are in the response.
    return rules.findOneByOrFail({ id: rule.id });
  }

  /** null when the rule is gone. */
  async replace(id: number, write: PlannerRuleWrite): Promise<PlannerRuleEntity | null> {
    const rules = this.dataSource.getRepository(PlannerRuleEntity);
    const rule = await rules.findOneBy({ id });
    if (rule === null) return null;
    rule.description = write.description;
    rule.updatedAt = new Date();
    return rules.save(rule);
  }

  /** false when the rule did not exist. */
  async delete(id: number): Promise<boolean> {
    const result = await this.dataSource.getRepository(PlannerRuleEntity).delete({ id });
    return (result.affected ?? 0) > 0;
  }
}
