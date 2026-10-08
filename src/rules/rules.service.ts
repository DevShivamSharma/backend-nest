import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/http/authenticated-request';
import { HallsService } from '../venues/halls.service';
import { DRAWING_PROFILES, drawingProfile } from './drawing-profiles';
import { CheckLayoutDto, UpdateRulesDto } from './dto/rules.dto';
import {
  effectiveValues,
  RULE_IDS,
  RuleId,
  RULES,
  RuleSwitches,
  RuleValues,
  VALUE_LIMITS,
  valueProblems,
} from './rule-catalogue';
import { checkLayout, RuleReport } from './rule-engine';
import { OrganisationRulesEntity, RuleReference } from './rules.entity';

export interface RulesView {
  switches: Record<RuleId, boolean>;
  values: RuleValues;
  references: RuleReference[];
  drawingProfile: string;
  updatedAt: string;
}

export interface RuleCheckView extends RuleReport {
  hall: { id: string; name: string; version: number };
}

/** `name` is required by the table; the organisation's single row always carries this one. */
const ROW_NAME = 'Rules';

/**
 * An organisation's rules (Module C): the fixed checks switched on or off with their values,
 * and checking stalls on a hall against them. One set of rules per organisation.
 */
@Injectable()
export class RulesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly halls: HallsService,
    private readonly audit: AuditService,
  ) {}

  catalogue() {
    return { rules: RULES, limits: VALUE_LIMITS, profiles: DRAWING_PROFILES };
  }

  // ---- the organisation's rules -------------------------------------------------------------

  /** The organisation's rules; the first call gives it the standard ones. */
  async get(organisationId: string): Promise<RulesView> {
    return view(await this.row(this.dataSource.manager, organisationId));
  }

  async update(organisationId: string, dto: UpdateRulesDto, actor: Actor): Promise<RulesView> {
    const updated = await this.dataSource.transaction(async (em) => {
      const rules = await this.row(em, organisationId, true);
      const changed: string[] = [];
      if (dto.switches !== undefined) {
        const next = this.switches(dto.switches);
        const flipped = RULE_IDS.filter(
          (r) => (rules.switches[r] !== false) !== (next[r] !== false),
        );
        rules.switches = next;
        if (flipped.length) changed.push(`switches (${flipped.join(', ')})`);
      }
      if (dto.values !== undefined) {
        rules.values = this.values(dto.values);
        changed.push('values');
      }
      if (dto.references !== undefined) {
        rules.references = dto.references.map((r) => ({
          document: r.document,
          section: r.section ?? null,
          note: r.note ?? null,
        }));
        changed.push('references');
      }
      if (dto.drawingProfile !== undefined) {
        rules.drawingProfile = this.profile(dto.drawingProfile);
        changed.push('drawing profile');
      }
      const saved = await em.getRepository(OrganisationRulesEntity).save(rules);
      if (changed.length) {
        await this.audit.record(
          {
            action: 'rules.updated',
            actor,
            organisationId,
            targetType: 'rules',
            targetId: saved.id,
            metadata: { changed },
          },
          em,
        );
      }
      return saved;
    });
    return view(updated);
  }

  // ---- checking -----------------------------------------------------------------------------

  /** Checks stalls on a hall's current floor. Saves nothing. */
  async check(organisationId: string, dto: CheckLayoutDto): Promise<RuleCheckView> {
    const em = this.dataSource.manager;
    const hall = await this.halls.getHall(em, organisationId, dto.hallId);
    const floor = await this.halls.currentFloor(em, hall);
    const rules = await this.row(em, organisationId);
    const ids = new Set<string>();
    for (const s of dto.stalls) {
      if (ids.has(s.id)) throw new BadRequestException(`Stall id "${s.id}" appears twice.`);
      ids.add(s.id);
    }
    const report = checkLayout({
      floor,
      stalls: dto.stalls.map((s) => ({
        ...s,
        number: s.number ?? null,
        openSides: [...new Set(s.openSides)],
      })),
      switches: rules.switches,
      values: effectiveValues(rules.values),
      eventType: dto.eventType,
      overrides: (dto.overrides ?? []).map((o) => ({
        ruleId: o.ruleId,
        stallIds: o.stallIds ?? null,
        reason: o.reason,
      })),
      profile: drawingProfile(rules.drawingProfile),
    });
    return {
      ...report,
      hall: { id: hall.id, name: hall.name, version: hall.currentVersion },
    };
  }

  // ---- helpers ------------------------------------------------------------------------------

  /** The organisation's row, made with the standard rules when it has none. */
  private async row(
    em: EntityManager,
    organisationId: string,
    lock = false,
  ): Promise<OrganisationRulesEntity> {
    const repo = em.getRepository(OrganisationRulesEntity);
    const find = () =>
      repo.findOne({
        where: { organisationId, isDefault: true },
        ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
      });
    const found = await find();
    if (found) return found;
    // Two first visits at once: the one-default index keeps it to one row.
    await repo
      .createQueryBuilder()
      .insert()
      .values({ organisationId, name: ROW_NAME, isDefault: true })
      .orIgnore()
      .execute();
    const made = await find();
    if (!made) throw new NotFoundException('The organisation has no rules.');
    return made;
  }

  /** Known rules only; stored as given (a missing switch means on). */
  private switches(input: Record<string, boolean>): RuleSwitches {
    const out: RuleSwitches = {};
    for (const [key, on] of Object.entries(input)) {
      if (!(RULE_IDS as readonly string[]).includes(key)) {
        throw new BadRequestException(`"${key}" is not a rule.`);
      }
      if (typeof on !== 'boolean')
        throw new BadRequestException(`Switch "${key}" must be on or off.`);
      out[key as RuleId] = on;
    }
    return out;
  }

  private values(input: RuleValues | undefined): Partial<RuleValues> {
    if (!input) return {};
    const values = effectiveValues(input);
    const problems = valueProblems(values);
    if (problems.length) throw new BadRequestException(problems.join(' '));
    return values;
  }

  private profile(id: string): string {
    if (!drawingProfile(id)) throw new BadRequestException(`"${id}" is not a drawing profile.`);
    return id;
  }
}

function view(rules: OrganisationRulesEntity): RulesView {
  return {
    switches: Object.fromEntries(RULE_IDS.map((r) => [r, rules.switches?.[r] !== false])) as Record<
      RuleId,
      boolean
    >,
    values: effectiveValues(rules.values),
    references: rules.references ?? [],
    // A profile no longer offered (e.g. a renamed one) reads as no constraints.
    drawingProfile: drawingProfile(rules.drawingProfile)?.id ?? 'free',
    updatedAt: rules.updatedAt.toISOString(),
  };
}
