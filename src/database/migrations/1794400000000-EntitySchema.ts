import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Made by `migration:generate` from the entities, then cut to what the earlier migrations do not
 * already do: the email recipient master (its two tables, and the two lists the portal itself
 * sends to), and the checks and defaults of the older tables named as their entities name them.
 * Plan attachments, the audit log and hall rule switches stay with their own migrations
 * (1794100000000 to 1794300000000), which have run on staging.
 */

export class EntitySchema1794400000000 implements MigrationInterface {
  name = 'EntitySchema1794400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "idp"."T_STALL_PLAN" DROP CONSTRAINT "T_STALL_PLAN_review_status_check"`,
    );
    await queryRunner.query(`ALTER TABLE "idp"."T_RULE_SET" DROP CONSTRAINT "T_RULE_SET_id_check"`);
    await queryRunner.query(
      `CREATE TABLE "idp"."T_EMAIL_RECIPIENT_LIST" ("slug" character varying(60) NOT NULL, "name" character varying(120) NOT NULL, "description" character varying(300), "system" boolean NOT NULL DEFAULT false, "active" boolean NOT NULL DEFAULT true, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_c74aeb9118ed9035d3ac9046f3c" PRIMARY KEY ("slug"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "idp"."T_EMAIL_RECIPIENT" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "list_slug" character varying(60) NOT NULL, "email" character varying(254) NOT NULL, "name" character varying(120), "active" boolean NOT NULL DEFAULT true, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_91a8a7f99fb6e7f16c2e0044f43" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_EMAIL_RECIPIENT_LIST_EMAIL" ON "idp"."T_EMAIL_RECIPIENT" ("list_slug", "email") `,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_STALL_PLAN" ALTER COLUMN "content" SET DEFAULT '{"zones":[],"stalls":[],"seats":[],"objects":[]}'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_RULE_SET" ALTER COLUMN "switches" SET DEFAULT '{}'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_RULE_SET" ALTER COLUMN "rule_values" SET DEFAULT '{}'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_RULE_SET" ALTER COLUMN "doc_references" SET DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_STALL_PLAN" ADD CONSTRAINT "CHK_225a4827d2a84d83b01d1e8a2d" CHECK ("review_status" IN ('submitted', 'approved', 'rejected'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_RULE_SET" ADD CONSTRAINT "CHK_ef544d89af7dbce0123fdd29a6" CHECK ("id" = 1)`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_EMAIL_RECIPIENT" ADD CONSTRAINT "FK_5c958df9b660b79e9e899985701" FOREIGN KEY ("list_slug") REFERENCES "idp"."T_EMAIL_RECIPIENT_LIST"("slug") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(`INSERT INTO "idp"."T_EMAIL_RECIPIENT_LIST" ("slug", "name", "description", "system") VALUES
          ('plan-submitted', 'Plan sent for approval', 'ITPO staff told when an organiser sends a hall''s stall plan for approval.', true),
          ('plan-withdrawn', 'Plan withdrawn', 'ITPO staff told when an organiser takes a plan back.', true)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "idp"."T_EMAIL_RECIPIENT" DROP CONSTRAINT "FK_5c958df9b660b79e9e899985701"`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_RULE_SET" DROP CONSTRAINT "CHK_ef544d89af7dbce0123fdd29a6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_STALL_PLAN" DROP CONSTRAINT "CHK_225a4827d2a84d83b01d1e8a2d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_RULE_SET" ALTER COLUMN "doc_references" SET DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_RULE_SET" ALTER COLUMN "rule_values" SET DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_RULE_SET" ALTER COLUMN "switches" SET DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_STALL_PLAN" ALTER COLUMN "content" SET DEFAULT '{"seats": [], "zones": [], "stalls": [], "objects": []}'`,
    );
    await queryRunner.query(`DROP INDEX "idp"."UQ_EMAIL_RECIPIENT_LIST_EMAIL"`);
    await queryRunner.query(`DROP TABLE "idp"."T_EMAIL_RECIPIENT"`);
    await queryRunner.query(`DROP TABLE "idp"."T_EMAIL_RECIPIENT_LIST"`);
    await queryRunner.query(
      `ALTER TABLE "idp"."T_RULE_SET" ADD CONSTRAINT "T_RULE_SET_id_check" CHECK ((id = 1))`,
    );
    await queryRunner.query(
      `ALTER TABLE "idp"."T_STALL_PLAN" ADD CONSTRAINT "T_STALL_PLAN_review_status_check" CHECK (((review_status)::text = ANY ((ARRAY['submitted'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[])))`,
    );
  }
}
