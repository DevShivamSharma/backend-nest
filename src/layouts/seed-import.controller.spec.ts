import { ConfigService } from '@nestjs/config';
import { SeedImportController } from './seed-import.controller';
import { LayoutService } from './layout.service';

describe('trusted historical seed import exception', () => {
  it.each([undefined, '', 'wrong-token'])(
    'ADV-S01 missing/wrong token %p never calls persistence',
    (token) => {
      const save = jest.fn();
      const controller = new SeedImportController(
        { save } as unknown as LayoutService,
        new ConfigService({ SEED_TOKEN: 'unit-test-only-token' }),
      );
      expect(() => controller.seedImport({}, token)).toThrow();
      expect(save).not.toHaveBeenCalled();
    },
  );
  it('ADV-S02 configured token deliberately uses the historical placement bypass', async () => {
    const save = jest.fn().mockResolvedValue({ message: 'mock import' });
    const controller = new SeedImportController(
      { save } as unknown as LayoutService,
      new ConfigService({ SEED_TOKEN: 'unit-test-only-token' }),
    );
    await controller.seedImport({}, 'unit-test-only-token');
    expect(save).toHaveBeenCalledWith({}, { skipPlacementRules: true });
  });
});
