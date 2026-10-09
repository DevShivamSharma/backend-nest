import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drawings on a stall plan: lines, rectangles, circles, polylines and text, in metres of the
 * floor the event is drawn on. They are drawing only; the rules do not see them.
 *
 * `points` keeps the shape as the planner draws it: a line's two ends, a rectangle's opposite
 * corners, a circle's centre and a point on its edge, a polyline's points, a text's anchor.
 */
export class PlanObjects1792100000000 implements MigrationInterface {
  name = 'PlanObjects1792100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Ids come from the planner, like those of zones, stalls and seats.
    await queryRunner.query(`
      CREATE TABLE plan_objects (
        id uuid PRIMARY KEY,
        plan_id uuid NOT NULL REFERENCES stall_plans (id) ON DELETE CASCADE,
        kind varchar(10) NOT NULL,
        points jsonb NOT NULL,
        text varchar(120),
        color varchar(9) NOT NULL,
        sort_order integer NOT NULL,
        CONSTRAINT plan_objects_kind_check
          CHECK (kind IN ('line', 'rect', 'circle', 'polyline', 'text'))
      )
    `);
    await queryRunner.query(`CREATE INDEX plan_objects_plan_idx ON plan_objects (plan_id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE plan_objects');
  }
}
