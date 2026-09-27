import { planStalls } from './plan-stalls';
import { parseSimple, type LayoutIntent } from './intent';
import type { AssistRequest } from './assist-request';
import { buildPlacementContext } from '../placement/hall-geometry';
import { auditLayout } from '../placement/placement-rules';

const cases = (['rows', 'back_to_back', 'island', 'perimeter'] as const).flatMap((arrangement) =>
  ['rectangle', 'notch', 'circle'].map((shape) => ({ arrangement, shape })),
);

describe('adversarial auto-layout proposals', () => {
  it.each(cases)(
    'ADV-P01 $arrangement / $shape passes whole-layout final validation',
    ({ arrangement, shape }) => {
      const request: AssistRequest = {
        requirement: '6 stalls of 2x2',
        existingStalls: [],
        hall: {
          name: 'Proposal audit',
          shape: shape === 'circle' ? 'CIRCLE' : 'SQUARE',
          width: 60,
          length: 60,
          radius: 30,
          eventType: 'B2C',
          rules: { minPassageWidth: { B2B: 3, B2C: 5 }, peripheralClearance: 0 },
          ...(shape === 'notch'
            ? {
                boundary: [
                  { x: -30, z: -30 },
                  { x: 30, z: -30 },
                  { x: 30, z: 0 },
                  { x: 0, z: 0 },
                  { x: 0, z: 30 },
                  { x: -30, z: 30 },
                ],
              }
            : {}),
        },
      };
      const original = JSON.stringify(request);
      const intent: LayoutIntent = { ...parseSimple(request.requirement), arrangement };
      const plan = planStalls(intent, request);
      expect(plan.stalls).toHaveLength(6);
      // Check all proposals together; validating only the latest candidate can hide
      // a new stall blocking an earlier one's open side or corner passage.
      expect(auditLayout(buildPlacementContext(request.hall, 'B2C', plan.stalls))).toEqual([]);
      expect(JSON.stringify(request)).toBe(original);
    },
  );
});
