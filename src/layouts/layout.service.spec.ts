import { ConfigService } from '@nestjs/config';

import type { LayoutSaveRequestDto } from './dto/layout-save-request.dto';
import { LayoutAggregate, LayoutRepository, LayoutWrite } from './layout.repository';
import { PlacementRejectedError } from '../common/errors/domain.errors';
import { LayoutService } from './layout.service';

/** Write-side rules BR-14 … BR-19, observed through what the service hands the repository. */

function aggregateFrom(write: LayoutWrite, layoutId = 1000): LayoutAggregate {
  return {
    layout: { id: layoutId, hallId: 1000, ...write } as never,
    hall: { id: 1000, ...write.hall } as never,
    stalls: write.stalls.map((s, i) => ({ id: 1000 + i, layoutId, ...s })) as never,
  };
}

/** A stored layout with these stalls, for update() and audit(). */
function existing(
  stalls: Array<Record<string, unknown>>,
  hall: Record<string, unknown> = {},
  nextStallSeq = stalls.length + 1,
): LayoutAggregate {
  return {
    layout: {
      id: 1000,
      name: 'x',
      hallWidth: 40,
      hallLength: 40,
      hallHeight: 0,
      hallId: 1000,
      eventType: 'B2B',
      nextStallSeq,
    } as never,
    hall: {
      id: 1000,
      name: 'Main Hall',
      shape: 'SQUARE',
      width: 40,
      length: 40,
      radius: 0,
      ...hall,
    } as never,
    stalls: stalls.map((s, i) => ({
      id: 2000 + i,
      layoutId: 1000,
      height: 4,
      status: 'AVAILABLE',
      ...s,
    })) as never,
  };
}

function setup(maxStalls = 2000) {
  const repo = {
    create: jest.fn(async (w: LayoutWrite) => aggregateFrom(w)),
    replace: jest.fn<
      ReturnType<LayoutRepository['replace']>,
      Parameters<LayoutRepository['replace']>
    >(),
    lastWrite: undefined as LayoutWrite | undefined,
    // update() reads the current layout first (BR-25); by default it exists and is empty.
    findById: jest.fn(async (): Promise<LayoutAggregate | null> => existing([])),
    delete: jest.fn(),
    listSummaries: jest.fn(),
  };
  repo.replace.mockImplementation(async (id, build) => {
    const current = await repo.findById();
    if (!current) return null;
    const write = await build(current, {} as never);
    repo.lastWrite = write ?? undefined;
    return write ? aggregateFrom(write, id) : current;
  });
  const config = { getOrThrow: () => ({ maxStallsPerLayout: maxStalls }) };
  const service = new LayoutService(
    repo as unknown as LayoutRepository,
    config as unknown as ConfigService,
  );

  return { repo, service };
}

const request = (overrides: Partial<LayoutSaveRequestDto> = {}): LayoutSaveRequestDto => ({
  layoutName: 'Expo 2026',
  hall: { name: 'Main Hall', shape: 'SQUARE', width: 40, length: 40, radius: 0 },
  stalls: [],
  ...overrides,
});

describe('LayoutService', () => {
  it('ADV-N01 rejects automatic identifier sequence exhaustion before persistence', async () => {
    const { service, repo } = setup();
    const make = (posX: number, stallNumber?: string) => ({
      name: 'Sequence limit',
      width: 2,
      length: 2,
      height: 3,
      posX,
      posZ: 0,
      openSides: ['FRONT'],
      stallNumber,
    });
    await expect(
      service.save(request({ stalls: [make(-10, 'STALL-2147483645'), make(0), make(10)] })),
    ).rejects.toThrow('sequence capacity');
    expect(repo.create).not.toHaveBeenCalled();
  });
  describe('BR-14 layout name', () => {
    it('uses the trimmed layoutName', async () => {
      const { repo, service } = setup();
      await service.save(request({ layoutName: '  Expo 2026  ' }));

      expect(repo.create.mock.calls[0][0].name).toBe('Expo 2026');
    });

    it.each([[null], [undefined], [''], ['   ']])(
      'falls back to the trimmed hall name when layoutName is %p',
      async (layoutName) => {
        const { repo, service } = setup();
        await service.save(
          request({
            layoutName,
            hall: { name: '  Main Hall ', shape: 'SQUARE', width: 40, length: 40 },
          }),
        );

        expect(repo.create.mock.calls[0][0].name).toBe('Main Hall');
      },
    );
  });

  it('BR-15 hallHeight is always 0', async () => {
    const { repo, service } = setup();
    await service.save(request());

    expect(repo.create.mock.calls[0][0].hallHeight).toBe(0);
  });

  describe('BR-17 stall defaults', () => {
    it('applies Shop / #3498db / FRONT and trims the name but not the colour', async () => {
      const { repo, service } = setup();
      await service.save(
        request({
          stalls: [
            {
              name: '  ',
              width: 5,
              length: 5,
              height: 4,
              posX: 0,
              posZ: 0,
              color: '',
              gateSide: null,
            },
            {
              name: ' Cafe ',
              width: 5,
              length: 5,
              height: 4,
              posX: 8,
              posZ: 0,
              color: ' #fff ',
              gateSide: ' left ',
            },
          ],
        }),
      );

      const [first, second] = repo.create.mock.calls[0][0].stalls;

      expect(first).toMatchObject({
        name: 'Shop',
        color: '#3498db',
        gateSide: 'FRONT',
        openSides: ['FRONT'],
      });
      expect(second).toMatchObject({
        name: 'Cafe',
        color: ' #fff ',
        gateSide: 'LEFT',
        openSides: ['LEFT'],
      });
    });
  });

  describe('openSides', () => {
    it('keeps the full list and syncs gateSide to the first open side', async () => {
      const { repo, service } = setup();
      await service.save(
        request({
          stalls: [
            {
              name: 'A',
              width: 5,
              length: 5,
              height: 4,
              posX: 0,
              posZ: 0,
              gateSide: 'BACK',
              openSides: ['LEFT', 'BACK'],
            },
          ],
        }),
      );

      expect(repo.create.mock.calls[0][0].stalls[0]).toMatchObject({
        gateSide: 'LEFT',
        openSides: ['LEFT', 'BACK'],
      });
    });

    it('dedupes entries and derives the list from gateSide when absent or empty', async () => {
      const { repo, service } = setup();
      await service.save(
        request({
          stalls: [
            {
              name: 'A',
              width: 5,
              length: 5,
              height: 4,
              posX: 0,
              posZ: 0,
              gateSide: 'RIGHT',
              openSides: ['right', 'RIGHT'],
            },
            {
              name: 'B',
              width: 5,
              length: 5,
              height: 4,
              posX: 8,
              posZ: 0,
              gateSide: 'left',
              openSides: [],
            },
          ],
        }),
      );

      const [first, second] = repo.create.mock.calls[0][0].stalls;
      expect(first.openSides).toEqual(['RIGHT']);
      expect(second.openSides).toEqual(['LEFT']);
      expect(second.gateSide).toBe('LEFT');
    });

    it('the response stall carries openSides', async () => {
      const { service } = setup();
      const result = await service.save(
        request({
          stalls: [
            {
              name: 'A',
              width: 5,
              length: 5,
              height: 4,
              posX: 0,
              posZ: 0,
              openSides: ['FRONT', 'RIGHT'],
            },
          ],
        }),
      );

      expect(result.stalls[0].openSides).toEqual(['FRONT', 'RIGHT']);
    });

    it('legacy rows without open_sides derive the list from gate_side', async () => {
      const { repo, service } = setup();
      const aggregate = aggregateFrom({
        name: 'x',
        hall: {} as never,
        stalls: [
          {
            name: 'A',
            width: 5,
            length: 5,
            height: 4,
            posX: 0,
            posZ: 0,
            color: '#3498db',
            gateSide: 'BACK',
            openSides: [] as string[],
            stallNumber: 'STALL-001',
            status: 'AVAILABLE',
            stallTypeId: null,
          },
        ],
        hallWidth: 0,
        hallLength: 0,
        hallHeight: 0,
        eventType: 'B2B',
        nextStallSeq: 2,
      });
      aggregate.stalls[0].openSides = null as never;
      repo.findById.mockResolvedValue(aggregate);

      const result = await service.get(1000);

      expect(result.stalls[0].openSides).toEqual(['BACK']);
    });
  });

  it('BR-18 client ids never reach the repository', async () => {
    const { repo, service } = setup();
    await service.save(
      request({
        hall: { id: 7, name: 'Main Hall', shape: 'SQUARE', width: 40, length: 40 },
        stalls: [{ id: 99, name: 'A', width: 5, length: 5, height: 4, posX: 0, posZ: 0 }],
      }),
    );

    const write = repo.create.mock.calls[0][0];

    expect(write.hall).not.toHaveProperty('id');
    expect(write.stalls[0]).not.toHaveProperty('id');
  });

  describe('BR-19 hall copy', () => {
    it('stores the shape normalised but the hall name UNtrimmed', async () => {
      const { repo, service } = setup();
      await service.save(
        request({ hall: { name: '  Main Hall ', shape: ' square ', width: 40, length: 40 } }),
      );

      expect(repo.create.mock.calls[0][0].hall).toMatchObject({
        name: '  Main Hall ',
        shape: 'SQUARE',
      });
    });

    it('a circular layout stores hallWidth = hallLength = 0', async () => {
      const { repo, service } = setup();
      await service.save(
        request({ hall: { name: 'Lounge', shape: 'CIRCLE', width: 0, length: 0, radius: 20 } }),
      );

      expect(repo.create.mock.calls[0][0]).toMatchObject({ hallWidth: 0, hallLength: 0 });
    });

    it('copyHall keeps blockedAreas, defaulting to null when absent', async () => {
      const { repo, service } = setup();
      const areas = [{ posX: 0, posZ: 0, width: 10, length: 4, kind: 'wall', color: '#742371' }];

      await service.save(
        request({
          hall: { name: 'H', shape: 'SQUARE', width: 40, length: 40, blockedAreas: areas },
        }),
      );
      expect(repo.create.mock.calls[0][0].hall.blockedAreas).toEqual(areas);

      await service.save(request({ hall: { name: 'H', shape: 'SQUARE', width: 40, length: 40 } }));
      expect(repo.create.mock.calls[1][0].hall.blockedAreas).toBeNull();
    });

    it('the response hall carries blockedAreas', async () => {
      const { service } = setup();
      const areas = [{ posX: 1, posZ: 2, width: 3, length: 4, kind: 'outside', color: '#ffffff' }];
      const result = await service.save(
        request({
          hall: { name: 'H', shape: 'SQUARE', width: 40, length: 40, blockedAreas: areas },
        }),
      );

      expect(result.hall?.blockedAreas).toEqual(areas);
    });
  });

  describe('response envelope (ADR-009)', () => {
    it('save: message + the hall and stalls both nested and top-level', async () => {
      const { service } = setup();
      const result = await service.save(
        request({ stalls: [{ name: 'A', width: 5, length: 5, height: 4, posX: 0, posZ: 0 }] }),
      );

      expect(result.message).toBe('Layout saved successfully.');
      expect(result.layout.hall).toEqual(result.hall);
      expect(result.layout.stalls).toEqual(result.stalls);
      expect(Object.keys(result.stalls[0])).toEqual([
        'id',
        'rotation',
        'parentStallNumber',
        'isSplitParent',
        'name',
        'width',
        'length',
        'height',
        'posX',
        'posZ',
        'color',
        'gateSide',
        'openSides',
        'stallNumber',
        'status',
        'stallTypeId',
      ]);
    });

    it('update: its own message', async () => {
      const { service } = setup();

      expect((await service.update(1000, request())).message).toBe('Layout updated successfully.');
    });

    it('get: message is null', async () => {
      const { repo, service } = setup();
      repo.findById.mockResolvedValue(
        aggregateFrom({
          ...({} as LayoutWrite),
          name: 'x',
          hall: {} as never,
          stalls: [],
          hallWidth: 0,
          hallLength: 0,
          hallHeight: 0,
        }),
      );

      expect((await service.get(1000)).message).toBeNull();
    });
  });

  describe('not found is a 400-class domain error with the Java text (ADR-003)', () => {
    it('get', async () => {
      const { repo, service } = setup();
      repo.findById.mockResolvedValue(null);

      await expect(service.get(42)).rejects.toThrow('Layout not found: 42');
    });

    it('update', async () => {
      const { repo, service } = setup();
      repo.findById.mockResolvedValue(null);

      await expect(service.update(42, request())).rejects.toThrow('Layout not found: 42');
    });

    it('delete', async () => {
      const { repo, service } = setup();
      repo.delete.mockResolvedValue(false);

      await expect(service.delete(42)).rejects.toThrow('Layout not found: 42');
    });

    it('update validates the body BEFORE looking the layout up (Java order)', async () => {
      const { repo, service } = setup();

      await expect(service.update(42, request({ hall: null }))).rejects.toThrow(
        'Hall data is required.',
      );
      expect(repo.replace).not.toHaveBeenCalled();
    });
  });

  it('nothing is written when validation fails', async () => {
    const { repo, service } = setup();

    await expect(service.save(request({ hall: { name: '', shape: 'SQUARE' } }))).rejects.toThrow();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('R-07 rejects more stalls than the configured maximum before validating them', async () => {
    const { service } = setup(2);
    const stalls = [0, 8, 16].map((posX) => ({
      name: 'S',
      width: 5,
      length: 5,
      height: 4,
      posX,
      posZ: 0,
    }));

    await expect(service.save(request({ stalls }))).rejects.toThrow(
      'Too many stalls: 3. Maximum is 2.',
    );
  });
});

describe('LayoutService — rule-driven halls', () => {
  // A 40 x 40 hall (centre origin) that carries rules, so BR-24 applies. Default rules:
  // 3 m B2B passage, 1 m peripheral clearance, 1 m snap.
  const ruledHall = {
    name: 'Ruled Hall',
    shape: 'SQUARE',
    width: 40,
    length: 40,
    radius: 0,
    boundary: [
      { x: -20, z: -20 },
      { x: 20, z: -20 },
      { x: 20, z: 20 },
      { x: -20, z: 20 },
    ],
    rules: {},
  };
  const stallAt = (posX: number, extra: Record<string, unknown> = {}) => ({
    name: 'S',
    width: 3,
    length: 2,
    height: 4,
    posX,
    posZ: 0,
    ...extra,
  });

  describe('BR-25 stable stall numbers', () => {
    it('save numbers every stall from STALL-001 and stores the next sequence', async () => {
      const { repo, service } = setup();
      const result = await service.save(
        request({ hall: ruledHall, stalls: [stallAt(0), stallAt(10)] }),
      );

      expect(result.stalls.map((s) => s.stallNumber)).toEqual(['STALL-001', 'STALL-002']);
      expect(repo.create.mock.calls[0][0].nextStallSeq).toBe(3);
    });

    it('update keeps issued numbers and never reuses a removed one', async () => {
      const { repo, service } = setup();
      repo.findById.mockResolvedValue(
        existing(
          [
            { stallNumber: 'STALL-001', ...stallAt(-10) },
            { stallNumber: 'STALL-002', ...stallAt(0) },
            { stallNumber: 'STALL-003', ...stallAt(10) },
          ],
          ruledHall,
        ),
      );

      // STALL-002 is removed; a new stall is added.
      const result = await service.update(
        1000,
        request({
          hall: ruledHall,
          stalls: [
            stallAt(-10, { stallNumber: 'STALL-001' }),
            stallAt(10, { stallNumber: 'STALL-003' }),
            stallAt(4),
          ],
        }),
      );

      expect(result.stalls.map((s) => s.stallNumber)).toEqual([
        'STALL-001',
        'STALL-003',
        'STALL-004',
      ]);
      expect(repo.lastWrite?.nextStallSeq).toBe(5);
    });

    it('a cancelled stall keeps its number and status', async () => {
      const { repo, service } = setup();
      repo.findById.mockResolvedValue(
        existing([{ stallNumber: 'STALL-001', ...stallAt(0) }], ruledHall),
      );

      const result = await service.update(
        1000,
        request({
          hall: ruledHall,
          stalls: [stallAt(0, { stallNumber: 'STALL-001', status: 'cancelled' })],
        }),
      );

      expect(result.stalls[0]).toEqual(
        expect.objectContaining({ stallNumber: 'STALL-001', status: 'CANCELLED' }),
      );
    });

    it('accepts an explicit parent identifier on creation', async () => {
      const { service } = setup();
      const result = await service.save(request({ stalls: [stallAt(0, { stallNumber: '5-10' })] }));

      expect(result.stalls[0].stallNumber).toBe('5-10');
    });

    it('rejects the same issued number on two stalls', async () => {
      const { repo, service } = setup();
      repo.findById.mockResolvedValue(existing([{ stallNumber: 'STALL-001', ...stallAt(0) }]));

      await expect(
        service.update(
          1000,
          request({
            stalls: [
              stallAt(-10, { stallNumber: 'STALL-001' }),
              stallAt(10, { stallNumber: 'STALL-001' }),
            ],
          }),
        ),
      ).rejects.toThrow('Stall number STALL-001 is used by more than one stall.');
    });
  });

  describe('BR-24 placement rules', () => {
    it('rejects a new stall with a 2 m gap and reports what and where', async () => {
      const { repo, service } = setup();
      const error = await service
        .save(request({ hall: ruledHall, stalls: [stallAt(0), stallAt(5)] }))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PlacementRejectedError);
      const rejected = error as PlacementRejectedError;
      expect(rejected.message).toBe(
        'Stall 0 (S) placement rejected: Required 3 m clear passage; 2 m available next to 1.',
      );
      expect(rejected.violations[0]).toEqual(
        expect.objectContaining({
          stallIndex: 0,
          code: 'PATHWAY_WIDTH',
          ruleRef: 'Placement',
          requiredWidth: 3,
          actualWidth: 2,
          geometry: [expect.objectContaining({ type: 'polygon' })],
        }),
      );
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('blocks an unchanged existing stall if it breaks a rule', async () => {
      const { repo, service } = setup();
      // STALL-001 touches the wall (0 m < 1 m peripheral) — existing state, reported by audit.
      repo.findById.mockResolvedValue(
        existing([{ stallNumber: 'STALL-001', ...stallAt(-18.5) }], ruledHall),
      );

      await expect(
        service.update(
          1000,
          request({ hall: ruledHall, stalls: [stallAt(-18.5, { stallNumber: 'STALL-001' })] }),
        ),
      ).rejects.toThrow(PlacementRejectedError);
    });

    it('checks the same stall once it is moved', async () => {
      const { repo, service } = setup();
      repo.findById.mockResolvedValue(
        existing([{ stallNumber: 'STALL-001', ...stallAt(0) }], ruledHall),
      );

      await expect(
        service.update(
          1000,
          request({ hall: ruledHall, stalls: [stallAt(-18.5, { stallNumber: 'STALL-001' })] }),
        ),
      ).rejects.toThrow('Required 1 m peripheral clearance; 0 m available.');
    });

    it('applies to halls without rules', async () => {
      const { service } = setup();
      await expect(service.save(request({ stalls: [stallAt(0), stallAt(5)] }))).rejects.toThrow(
        PlacementRejectedError,
      );
    });

    it('can be skipped by trusted imports of existing production placements', async () => {
      const { service } = setup();
      await expect(
        service.save(request({ hall: ruledHall, stalls: [stallAt(0), stallAt(5)] }), {
          skipPlacementRules: true,
        }),
      ).resolves.toBeDefined();
    });

    it("BR-13 ignores cancelled stalls: a new stall may take a cancelled stall's space", async () => {
      const { service } = setup();
      await expect(
        service.save(request({ stalls: [stallAt(0, { status: 'CANCELLED' }), stallAt(0)] })),
      ).resolves.toBeDefined();
    });
  });

  describe('audit', () => {
    it('reports existing problems without blocking', async () => {
      const { repo, service } = setup();
      repo.findById.mockResolvedValue(
        existing(
          [
            { stallNumber: 'STALL-001', ...stallAt(0) },
            { stallNumber: 'STALL-002', ...stallAt(5) },
          ],
          ruledHall,
        ),
      );

      const audit = await service.audit(1000);

      expect(audit.ruleDriven).toBe(true);
      expect(audit.valid).toBe(false);
      expect(audit.entries).toEqual([expect.objectContaining({ stallNumber: 'STALL-001' })]);
    });

    it('audits even a hall without explicit rules', async () => {
      const { service } = setup();
      expect(await service.audit(1000)).toEqual({
        layoutId: 1000,
        ruleDriven: true,
        valid: true,
        entries: [],
      });
    });
  });

  describe('BR-22 / BR-23 input checks', () => {
    it('rejects a boundary with fewer than 3 points', async () => {
      const { service } = setup();
      await expect(
        service.save(request({ hall: { ...ruledHall, boundary: [{ x: 0, z: 0 }] } })),
      ).rejects.toThrow('Hall boundary must be a polygon of at least 3 points.');
    });

    it('rejects an unknown zone kind', async () => {
      const { service } = setup();
      await expect(
        service.save(
          request({ hall: { ...ruledHall, zones: [{ id: 'z', kind: 'LAVA', polygon: [] }] } }),
        ),
      ).rejects.toThrow('Zone 0 has an unknown kind.');
    });

    it('rejects an unknown stall status', async () => {
      const { service } = setup();
      await expect(
        service.save(request({ stalls: [stallAt(0, { status: 'SOLD' })] })),
      ).rejects.toThrow('status must be AVAILABLE, BOOKED or CANCELLED.');
    });

    it('rejects an unknown event type', async () => {
      const { service } = setup();
      await expect(service.save(request({ eventType: 'B2X' }))).rejects.toThrow(
        'eventType must be B2B or B2C.',
      );
    });
  });
});
