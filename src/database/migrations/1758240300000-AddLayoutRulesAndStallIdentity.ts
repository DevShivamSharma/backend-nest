import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rule-driven layout editor.
 *
 *  - hall: polygon boundary, restricted zones, openings, plan markers and placement rules
 *    (all optional jsonb; NULL keeps today's rectangle/circle behaviour).
 *  - layouts: event type (B2B/B2C passage width) and the stall-number sequence.
 *  - stalls: persisted stall number, status and stall type.
 *
 * Existing stalls are numbered STALL-001… per layout in id order, and each layout's sequence
 * continues after its highest number, so the backfill never collides with new stalls.
 */
export class AddLayoutRulesAndStallIdentity1758240300000 implements MigrationInterface {
  name = 'AddLayoutRulesAndStallIdentity1758240300000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS: see AddBlockedAreas1758240100000.
    await queryRunner.query(`ALTER TABLE hall ADD COLUMN IF NOT EXISTS boundary jsonb NULL`);
    await queryRunner.query(`ALTER TABLE hall ADD COLUMN IF NOT EXISTS zones jsonb NULL`);
    await queryRunner.query(`ALTER TABLE hall ADD COLUMN IF NOT EXISTS openings jsonb NULL`);
    await queryRunner.query(`ALTER TABLE hall ADD COLUMN IF NOT EXISTS markers jsonb NULL`);
    await queryRunner.query(`ALTER TABLE hall ADD COLUMN IF NOT EXISTS rules jsonb NULL`);

    await queryRunner.query(
      `ALTER TABLE layouts ADD COLUMN IF NOT EXISTS event_type varchar(8) NOT NULL DEFAULT 'B2B'`,
    );
    await queryRunner.query(
      `ALTER TABLE layouts ADD COLUMN IF NOT EXISTS next_stall_seq integer NOT NULL DEFAULT 1`,
    );

    await queryRunner.query(`ALTER TABLE stalls ADD COLUMN IF NOT EXISTS stall_number varchar(32) NULL`);
    await queryRunner.query(
      `ALTER TABLE stalls ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'AVAILABLE'`,
    );
    await queryRunner.query(`ALTER TABLE stalls ADD COLUMN IF NOT EXISTS stall_type varchar(64) NULL`);

    // Backfill: number existing stalls per layout in id order.
    await queryRunner.query(`
      UPDATE stalls s
         SET stall_number = 'STALL-' || lpad(n.rn::text, 3, '0')
        FROM (SELECT id, row_number() OVER (PARTITION BY layout_id ORDER BY id) AS rn
                FROM stalls) n
       WHERE s.id = n.id AND s.stall_number IS NULL
    `);
    await queryRunner.query(`
      UPDATE layouts l
         SET next_stall_seq = c.cnt + 1
        FROM (SELECT layout_id, count(*) AS cnt FROM stalls GROUP BY layout_id) c
       WHERE l.id = c.layout_id AND l.next_stall_seq <= c.cnt
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_stalls_layout_stall_number
         ON stalls (layout_id, stall_number) WHERE stall_number IS NOT NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_stalls_layout_stall_number`);
    await queryRunner.query(`ALTER TABLE stalls DROP COLUMN stall_type`);
    await queryRunner.query(`ALTER TABLE stalls DROP COLUMN status`);
    await queryRunner.query(`ALTER TABLE stalls DROP COLUMN stall_number`);
    await queryRunner.query(`ALTER TABLE layouts DROP COLUMN next_stall_seq`);
    await queryRunner.query(`ALTER TABLE layouts DROP COLUMN event_type`);
    await queryRunner.query(`ALTER TABLE hall DROP COLUMN rules`);
    await queryRunner.query(`ALTER TABLE hall DROP COLUMN markers`);
    await queryRunner.query(`ALTER TABLE hall DROP COLUMN openings`);
    await queryRunner.query(`ALTER TABLE hall DROP COLUMN zones`);
    await queryRunner.query(`ALTER TABLE hall DROP COLUMN boundary`);
  }
}
