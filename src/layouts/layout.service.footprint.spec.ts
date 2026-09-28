import { ConfigService } from '@nestjs/config';

import { BadRequestDomainError } from '../common/errors/domain.errors';
import type { LayoutSaveRequestDto } from './dto/layout-save-request.dto';
import { LayoutAggregate, LayoutRepository, LayoutWrite } from './layout.repository';
import { LayoutService } from './layout.service';

/** Custom (polygon) stalls through the real write path: validate, canonicalise, persist, echo. */

function setup() {
  let stored: LayoutAggregate | null = null;
  const repo = {
    create: jest.fn(async (w: LayoutWrite) => {
      stored = {
        layout: { id: 1000, hallId: 1000, ...w } as never,
        hall: { id: 1000, ...w.hall } as never,
        stalls: w.stalls.map((s, i) => ({ id: 1000 + i, layoutId: 1000, ...s })) as never,
      };
      return stored;
    }),
    replace: jest.fn(async (_id: number, build: (c: LayoutAggregate, m: never) => Promise<LayoutWrite | null>) => {
      const write = await build(stored as LayoutAggregate, { query: async () => [] } as never);
      return write ? { ...(stored as LayoutAggregate), stalls: write.stalls as never } : stored;
    }),
    findById: jest.fn(async () => stored),
    delete: jest.fn(),
    listSummaries: jest.fn(),
  };
  const config = { getOrThrow: () => ({ maxStallsPerLayout: 2000 }) };
  return {
    repo,
    service: new LayoutService(repo as unknown as LayoutRepository, config as unknown as ConfigService),
  };
}

// The 30 m² L of block 11-13/11-14: 7 x 3 m along the top, 3 x 3 m down the right.
const L = [
  { x: 0, z: 0 },
  { x: 7, z: 0 },
  { x: 7, z: 6 },
  { x: 4, z: 6 },
  { x: 4, z: 3 },
  { x: 0, z: 3 },
];

const request = (stall: Record<string, unknown>): LayoutSaveRequestDto =>
  ({
    layoutName: 'PDF import',
    hall: { name: 'Main Hall', shape: 'SQUARE', width: 40, length: 40, radius: 0 },
    stalls: [{ name: '11-14 H', height: 3, width: 7, length: 6, posX: -10, posZ: -10, ...stall }],
  }) as never;

describe('LayoutService — custom (L-shaped) stalls', () => {
  it('stores one L-shaped stall with its canonical outline, bounding box and open edges', async () => {
    const { repo, service } = setup();
    const result = await service.save(request({ footprint: L, openEdges: [3, 4] }));
    const written = repo.create.mock.calls[0][0].stalls[0];

    expect(written.footprint).toEqual([
      { x: -3.5, z: -3 },
      { x: 3.5, z: -3 },
      { x: 3.5, z: 3 },
      { x: 0.5, z: 3 },
      { x: 0.5, z: 0 },
      { x: -3.5, z: 0 },
    ]);
    expect(written.openEdges).toEqual([3, 4]);
    expect([written.width, written.length]).toEqual([7, 6]);
    // The outline was given relative to (-10, -10) at its corner: the stall's position is now
    // the centre of its bounding box, like a rectangle's.
    expect([written.posX, written.posZ]).toEqual([-6.5, -7]);
    expect(written.openSides).toEqual(['LEFT', 'FRONT']);
    expect(result.stalls[0]).toEqual(
      expect.objectContaining({ footprint: written.footprint, openEdges: [3, 4] }),
    );
  });

  it('echoes a saved L-shape unchanged on the next save (reload round trip)', async () => {
    const { repo, service } = setup();
    const first = await service.save(request({ footprint: L, openEdges: [3, 4] }));
    const again = { ...first.stalls[0] } as Record<string, unknown>;
    await service.save(request(again));
    const written = repo.create.mock.calls[1][0].stalls[0];
    expect(written.footprint).toEqual(first.stalls[0].footprint);
    expect([written.posX, written.posZ, written.width, written.length]).toEqual([
      first.stalls[0].posX,
      first.stalls[0].posZ,
      7,
      6,
    ]);
    expect(written.openEdges).toEqual([3, 4]);
  });

  it('leaves rectangles exactly as before: no footprint keys in the response', async () => {
    const { service } = setup();
    const result = await service.save(request({ width: 3, length: 4 }));
    expect('footprint' in result.stalls[0]).toBe(false);
    expect('openEdges' in result.stalls[0]).toBe(false);
  });

  it.each([
    [{ footprint: [{ x: 0, z: 0 }, { x: 1, z: 0 }] }, 'at least 3'],
    [{ footprint: L, openEdges: [9] }, 'openEdges'],
    [{ openEdges: [0] }, 'needs a footprint'],
  ])('rejects %j', async (extra, message) => {
    const { service } = setup();
    await expect(service.save(request(extra))).rejects.toThrow(BadRequestDomainError);
    await expect(service.save(request(extra))).rejects.toThrow(message);
  });

  it('rejects an L-shape that overlaps another stall through its arm, not its notch', async () => {
    const { service } = setup();
    // A 1 x 1 m box in the notch (local x 0..4, z 3..6 -> plan x -10..-6, z -7..-4): no overlap.
    const inNotch = { name: 'N', height: 3, width: 1, length: 1, posX: -9.5, posZ: -5.5 };
    const onArm = { ...inNotch, posX: -4, posZ: -9 };
    const hall = { name: 'Main Hall', shape: 'SQUARE', width: 40, length: 40, radius: 0, rules: { peripheralClearance: 0 } };
    const lStall = { name: 'L', height: 3, width: 7, length: 6, posX: -10, posZ: -10, footprint: L, openEdges: [0] };
    const save = (other: Record<string, unknown>) =>
      service.save({ layoutName: 'x', hall, stalls: [lStall, other] } as never);
    await expect(save(onArm)).rejects.toThrow(/Overlaps/);
    // In the notch the box does not overlap the L; it is only too close to it (a passage rule,
    // judged against the L's real edges, 1 m away).
    const codes = await save(inNotch).then(
      () => [] as string[],
      (e: { violations?: Array<{ code: string }> }) => (e.violations ?? []).map((v) => v.code),
    );
    expect(codes).not.toContain('STALL_OVERLAP');
    expect(codes).toContain('PATHWAY_WIDTH');
  });

  it('refuses to split a custom stall', async () => {
    const { service } = setup();
    const saved = await service.save(request({ footprint: L, openEdges: [0] }));
    const number = saved.stalls[0].stallNumber as string;
    await expect(
      service.split(1000, number, {
        idempotencyKey: 'k1',
        children: [
          { name: 'a', width: 1, length: 1, height: 3, posX: 0, posZ: 0 },
          { name: 'b', width: 1, length: 1, height: 3, posX: 3, posZ: 0 },
        ],
      } as never),
    ).rejects.toThrow(/cannot be split/);
  });
});
