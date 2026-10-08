import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import { geometryProblems } from './geometry';
const coordinate = z.number().finite().min(-1e7).max(1e7);
const point = z.tuple([coordinate, coordinate]);
const geometry = z
  .array(z.array(z.array(point).min(4).max(2000)).min(1).max(100))
  .min(1)
  .max(500)
  .refine((g) => !geometryProblems(g).length, 'Invalid or self-crossing polygon');
const name = z.string().trim().min(1).max(200);
const id = z.string().regex(/^[\w-]{1,100}$/);
const grid = z
  .object({
    x: coordinate,
    y: coordinate,
    width: z.number().min(0.000001).max(1e7),
    height: z.number().min(0.000001).max(1e7),
    rotation: z.number().min(-360).max(360),
  })
  .strict();
const kinds = z.enum([
  'unknown',
  'outside',
  'wall',
  'column',
  'passage',
  'fire_curtain',
  'no_build',
  'utility',
  'entry',
  'unavailable',
  'void',
  'facility',
  'marking',
]);
export const editSchema = z
  .object({
    revision: z.number().int().positive(),
    page: z.number().int().positive(),
    regions: z
      .array(
        z
          .object({
            id,
            name,
            role: z.enum(['hall', 'foyer', 'circulation', 'exclude']),
            geometry,
            hallIds: z.array(id).max(100),
            confirmed: z.boolean(),
            restrictionsConfirmed: z.boolean().optional(),
            grid: grid.nullable(),
            printedArea: z.number().positive().max(4e6).nullable(),
          })
          .strict(),
      )
      .max(100),
    objects: z
      .array(
        z
          .object({
            id,
            kind: kinds,
            label: name,
            geometry,
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
            confirmed: z.boolean(),
            evidence: z
              .object({
                source: z.enum(['legend', 'text', 'geometry', 'user']),
                detail: z.string().max(1000),
              })
              .strict(),
          })
          .strict(),
      )
      .max(1000),
    grid: grid.nullable(),
    calibration: z
      .object({
        metresPerUnit: z.number().min(1e-9).max(1000).nullable(),
        source: name,
        confirmed: z.boolean(),
      })
      .strict(),
    dimensions: z
      .array(
        z
          .object({
            id,
            label: name,
            a: point,
            b: point,
            metres: z.number().positive().max(2000),
            regionId: id.nullable(),
            confirmed: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    annotations: z
      .array(
        z
          .object({
            id,
            type: z.enum(['facility', 'label']),
            text: name,
            kind: z.string().trim().min(1).max(80).nullable(),
            anchor: point,
            regionIds: z.array(id).min(1).max(100),
            confirmed: z.boolean(),
            evidence: z
              .object({
                source: z.enum(['legend', 'text', 'geometry', 'user']),
                detail: z.string().max(1000),
              })
              .strict(),
          })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict();
export const commitSchema = z
  .object({
    revision: z.number().int().positive(),
    selections: z
      .array(
        z
          .object({
            key: name,
            name: z.string().trim().min(1).max(120),
            targetHallId: z.uuid().nullable(),
            expectedVersion: z.number().int().positive().nullable(),
            acknowledgements: z.array(name).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException(
      result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .slice(0, 10)
        .join('; '),
    );
  return result.data;
}
