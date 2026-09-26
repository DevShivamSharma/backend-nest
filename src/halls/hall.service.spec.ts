import { BadRequestDomainError } from '../common/errors/domain.errors';
import type { HallDto } from '../layouts/dto/layout-save-request.dto';
import { HallEntity } from '../layouts/entities/hall.entity';
import type { HallWrite } from '../layouts/layout.repository';
import { HallRepository } from './hall.repository';
import { HallService } from './hall.service';

/**
 * /api/halls behaviour: the Java contract (ADR-002) plus the validation it never had (ADR-015).
 */

function entity(overrides: Partial<HallEntity> = {}): HallEntity {
  return {
    id: 1000,
    name: 'Main Hall',
    shape: 'SQUARE',
    width: 40,
    length: 40,
    radius: 0,
    blockedAreas: null,
    ...overrides,
  } as HallEntity;
}

function setup() {
  const repo = {
    findAll: jest.fn(async () => [entity()]),
    findById: jest.fn(async () => entity()),
    create: jest.fn(async (w: HallWrite) => entity({ ...w } as Partial<HallEntity>)),
    update: jest.fn(async (id: number, w: HallWrite) =>
      entity({ id, ...w } as Partial<HallEntity>),
    ),
    delete: jest.fn(async () => true),
  };
  const service = new HallService(repo as unknown as HallRepository);

  return { repo, service };
}

const hall = (overrides: Partial<HallDto> = {}): HallDto => ({
  name: 'Main Hall',
  shape: 'SQUARE',
  width: 40,
  length: 40,
  radius: 0,
  ...overrides,
});

describe('HallService', () => {
  describe('read', () => {
    it('lists every hall', async () => {
      const { service } = setup();

      await expect(service.list()).resolves.toEqual([
        { id: 1000, name: 'Main Hall', shape: 'SQUARE', width: 40, length: 40, radius: 0, blockedAreas: null, boundary: null, zones: null, openings: null, markers: null, amenities: null, rules: null },
      ]);
    });

    it('list returns blockedAreas when the hall has them', async () => {
      const { repo, service } = setup();
      const areas = [{ posX: 0, posZ: 0, width: 10, length: 4, kind: 'wall', color: '#742371' }];
      repo.findAll.mockResolvedValueOnce([entity({ blockedAreas: areas as never })]);

      await expect(service.list()).resolves.toEqual([
        expect.objectContaining({ blockedAreas: areas }),
      ]);
    });

    it('returns one hall by id', async () => {
      const { service } = setup();

      await expect(service.get(1000)).resolves.toMatchObject({ id: 1000, name: 'Main Hall' });
    });

    it('raises the Java not-found message when the hall is missing', async () => {
      const { repo, service } = setup();
      repo.findById.mockResolvedValueOnce(null as never);

      await expect(service.get(42)).rejects.toThrow(
        new BadRequestDomainError('Hall not found: 42'),
      );
    });
  });

  describe('create', () => {
    it('persists the five writable columns', async () => {
      const { repo, service } = setup();
      await service.create(hall({ name: 'Expo Hall', width: 30, length: 20 }));

      expect(repo.create).toHaveBeenCalledWith({
        name: 'Expo Hall',
        shape: 'SQUARE',
        width: 30,
        length: 20,
        radius: 0,
        blockedAreas: null,
        boundary: null,
        zones: null,
        openings: null,
        markers: null,
        rules: null,
      });
    });

    it('passes blockedAreas through on create', async () => {
      const { repo, service } = setup();
      const areas = [{ posX: 5, posZ: -5, width: 10, length: 4, kind: 'outside', color: '#ffffff' }];
      await service.create(hall({ blockedAreas: areas }));

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ blockedAreas: areas }));
    });

    it('drops any id sent by the client (BR-18, HallController.java:58)', async () => {
      const { repo, service } = setup();
      await service.create({ ...hall(), id: 7 } as HallDto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.not.objectContaining({ id: expect.anything() }),
      );
    });

    it('normalizes the shape', async () => {
      const { repo, service } = setup();
      await service.create(hall({ shape: '  circle  ', radius: 20 }));

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ shape: 'CIRCLE' }));
    });
  });

  // ADR-015: every case here is one the Java would have written to the database.
  describe('validation (ADR-015)', () => {
    it('rejects a missing body', async () => {
      const { service } = setup();

      await expect(service.create(null as unknown as HallDto)).rejects.toThrow(
        new BadRequestDomainError('Hall data is required.'),
      );
    });

    it('rejects a nonsense shape', async () => {
      const { service } = setup();

      await expect(service.create(hall({ shape: 'banana' }))).rejects.toThrow(
        new BadRequestDomainError('Hall shape must be SQUARE or CIRCLE.'),
      );
    });

    it('checks shape before name, as on the layout path', async () => {
      const { service } = setup();

      await expect(service.create(hall({ shape: 'banana', name: '   ' }))).rejects.toThrow(
        new BadRequestDomainError('Hall shape must be SQUARE or CIRCLE.'),
      );
    });

    it('rejects a blank name', async () => {
      const { service } = setup();

      await expect(service.create(hall({ name: '   ' }))).rejects.toThrow(
        new BadRequestDomainError('Hall name is required.'),
      );
    });

    it('rejects a non-positive width or length on a SQUARE hall', async () => {
      const { service } = setup();

      await expect(service.create(hall({ width: -5 }))).rejects.toThrow(
        new BadRequestDomainError('Hall width and length must be greater than 0.'),
      );
      await expect(service.create(hall({ length: 0 }))).rejects.toThrow(
        new BadRequestDomainError('Hall width and length must be greater than 0.'),
      );
    });

    it('rejects a non-positive radius on a CIRCLE hall', async () => {
      const { service } = setup();

      await expect(service.create(hall({ shape: 'CIRCLE', radius: 0 }))).rejects.toThrow(
        new BadRequestDomainError('Hall radius must be greater than 0.'),
      );
    });

    it('does not check width or length on a CIRCLE hall', async () => {
      const { service } = setup();

      await expect(
        service.create(hall({ shape: 'CIRCLE', width: 0, length: 0, radius: 20 })),
      ).resolves.toBeDefined();
    });

    it('applies the same rules on update', async () => {
      const { service } = setup();

      await expect(service.update(1000, hall({ name: '' }))).rejects.toThrow(
        new BadRequestDomainError('Hall name is required.'),
      );
    });
  });

  describe('update', () => {
    it('overwrites all five fields', async () => {
      const { repo, service } = setup();
      await service.update(1000, hall({ name: 'Renamed', width: 12, length: 8 }));

      expect(repo.update).toHaveBeenCalledWith(1000, {
        name: 'Renamed',
        shape: 'SQUARE',
        width: 12,
        length: 8,
        radius: 0,
        blockedAreas: null,
        boundary: null,
        zones: null,
        openings: null,
        markers: null,
        rules: null,
      });
    });

    it('passes blockedAreas through on update', async () => {
      const { repo, service } = setup();
      const areas = [{ posX: 0, posZ: 0, width: 6, length: 6, kind: 'zone', color: '#00ff00' }];
      await service.update(1000, hall({ blockedAreas: areas }));

      expect(repo.update).toHaveBeenCalledWith(
        1000,
        expect.objectContaining({ blockedAreas: areas }),
      );
    });

    it('raises not found when the hall is missing', async () => {
      const { repo, service } = setup();
      repo.update.mockResolvedValueOnce(null as never);

      await expect(service.update(42, hall())).rejects.toThrow(
        new BadRequestDomainError('Hall not found: 42'),
      );
    });
  });

  describe('delete', () => {
    it('deletes an existing hall', async () => {
      const { repo, service } = setup();

      await expect(service.delete(1000)).resolves.toBeUndefined();
      expect(repo.delete).toHaveBeenCalledWith(1000);
    });

    it('raises not found when the hall is missing', async () => {
      const { repo, service } = setup();
      repo.delete.mockResolvedValueOnce(false);

      await expect(service.delete(42)).rejects.toThrow(
        new BadRequestDomainError('Hall not found: 42'),
      );
    });
  });
});
