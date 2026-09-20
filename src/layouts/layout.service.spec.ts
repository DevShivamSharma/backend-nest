import { ConfigService } from '@nestjs/config';

import type { LayoutSaveRequestDto } from './dto/layout-save-request.dto';
import { LayoutAggregate, LayoutRepository, LayoutWrite } from './layout.repository';
import { LayoutService } from './layout.service';

/** Write-side rules BR-14 … BR-19, observed through what the service hands the repository. */

function aggregateFrom(write: LayoutWrite, layoutId = 1000): LayoutAggregate {
  return {
    layout: { id: layoutId, hallId: 1000, ...write } as never,
    hall: { id: 1000, ...write.hall } as never,
    stalls: write.stalls.map((s, i) => ({ id: 1000 + i, layoutId, ...s })) as never,
  };
}

function setup(maxStalls = 2000) {
  const repo = {
    create: jest.fn(async (w: LayoutWrite) => aggregateFrom(w)),
    replace: jest.fn(async (id: number, w: LayoutWrite) => aggregateFrom(w, id)),
    findById: jest.fn(),
    delete: jest.fn(),
    listSummaries: jest.fn(),
  };
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
          request({ layoutName, hall: { name: '  Main Hall ', shape: 'SQUARE', width: 40, length: 40 } }),
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
            { name: '  ', width: 5, length: 5, height: 4, posX: 0, posZ: 0, color: '', gateSide: null },
            { name: ' Cafe ', width: 5, length: 5, height: 4, posX: 8, posZ: 0, color: ' #fff ', gateSide: ' left ' },
          ],
        }),
      );

      const [first, second] = repo.create.mock.calls[0][0].stalls;

      expect(first).toMatchObject({ name: 'Shop', color: '#3498db', gateSide: 'FRONT', openSides: ['FRONT'] });
      expect(second).toMatchObject({ name: 'Cafe', color: ' #fff ', gateSide: 'LEFT', openSides: ['LEFT'] });
    });
  });

  describe('openSides', () => {
    it('keeps the full list and syncs gateSide to the first open side', async () => {
      const { repo, service } = setup();
      await service.save(
        request({
          stalls: [
            { name: 'A', width: 5, length: 5, height: 4, posX: 0, posZ: 0, gateSide: 'BACK', openSides: ['LEFT', 'BACK'] },
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
            { name: 'A', width: 5, length: 5, height: 4, posX: 0, posZ: 0, gateSide: 'RIGHT', openSides: ['right', 'RIGHT'] },
            { name: 'B', width: 5, length: 5, height: 4, posX: 8, posZ: 0, gateSide: 'left', openSides: [] },
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
            { name: 'A', width: 5, length: 5, height: 4, posX: 0, posZ: 0, openSides: ['FRONT', 'RIGHT'] },
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
          { name: 'A', width: 5, length: 5, height: 4, posX: 0, posZ: 0, color: '#3498db', gateSide: 'BACK', openSides: [] as string[] },
        ],
        hallWidth: 0,
        hallLength: 0,
        hallHeight: 0,
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

      await service.save(request({ hall: { name: 'H', shape: 'SQUARE', width: 40, length: 40, blockedAreas: areas } }));
      expect(repo.create.mock.calls[0][0].hall.blockedAreas).toEqual(areas);

      await service.save(request({ hall: { name: 'H', shape: 'SQUARE', width: 40, length: 40 } }));
      expect(repo.create.mock.calls[1][0].hall.blockedAreas).toBeNull();
    });

    it('the response hall carries blockedAreas', async () => {
      const { service } = setup();
      const areas = [{ posX: 1, posZ: 2, width: 3, length: 4, kind: 'outside', color: '#ffffff' }];
      const result = await service.save(
        request({ hall: { name: 'H', shape: 'SQUARE', width: 40, length: 40, blockedAreas: areas } }),
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
        'id', 'name', 'width', 'length', 'height', 'posX', 'posZ', 'color', 'gateSide', 'openSides',
      ]);
    });

    it('update: its own message', async () => {
      const { service } = setup();

      expect((await service.update(1000, request())).message).toBe('Layout updated successfully.');
    });

    it('get: message is null', async () => {
      const { repo, service } = setup();
      repo.findById.mockResolvedValue(aggregateFrom({ ...({} as LayoutWrite), name: 'x', hall: {} as never, stalls: [], hallWidth: 0, hallLength: 0, hallHeight: 0 }));

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
      repo.replace.mockResolvedValue(null as never);

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
    const stalls = [0, 8, 16].map((posX) => ({ name: 'S', width: 5, length: 5, height: 4, posX, posZ: 0 }));

    await expect(service.save(request({ stalls }))).rejects.toThrow(
      'Too many stalls: 3. Maximum is 2.',
    );
  });
});
