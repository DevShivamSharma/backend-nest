import { BadRequestDomainError } from '../common/errors/domain.errors';
import type { LayoutSaveRequestDto, StallDto } from './dto/layout-save-request.dto';
import { normalizeGate, normalizeShape, validateLayoutRequest } from './layout.validator';

/**
 * One test per rule in docs/04-business-rules.md Part A. Messages are asserted LITERALLY:
 * both frontends render them verbatim, so a changed character is a user-visible regression.
 */

const squareHall = () => ({ name: 'Main Hall', shape: 'SQUARE', width: 40, length: 40, radius: 0 });
const circleHall = () => ({ name: 'Lounge', shape: 'CIRCLE', width: 0, length: 0, radius: 20 });

const stall = (overrides: Partial<StallDto> = {}): StallDto => ({
  name: 'Shop',
  width: 5,
  length: 5,
  height: 4,
  posX: 0,
  posZ: 0,
  color: '#3498db',
  gateSide: 'FRONT',
  ...overrides,
});

function messageOf(request: unknown): string {
  try {
    validateLayoutRequest(request as LayoutSaveRequestDto);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestDomainError);
    return (error as Error).message;
  }

  throw new Error('expected validateLayoutRequest to throw');
}

const accepts = (request: unknown) =>
  expect(() => validateLayoutRequest(request as LayoutSaveRequestDto)).not.toThrow();

describe('validateLayoutRequest', () => {
  it('accepts a valid rectangular layout', () => {
    accepts({ layoutName: 'Expo', hall: squareHall(), stalls: [stall(), stall({ posX: 8 })] });
  });

  it('accepts a valid circular layout', () => {
    accepts({ hall: circleHall(), stalls: [stall()] });
  });

  it('BR-01 request body required', () => {
    expect(messageOf(null)).toBe('Request body is required.');
    expect(messageOf(undefined)).toBe('Request body is required.');
  });

  it('BR-02 hall required', () => {
    expect(messageOf({})).toBe('Hall data is required.');
    expect(messageOf({ hall: null })).toBe('Hall data is required.');
  });

  describe('BR-03 hall shape', () => {
    it.each([['TRIANGLE'], [''], [null], [undefined], ['   ']])('rejects %p', (shape) => {
      expect(messageOf({ hall: { ...squareHall(), shape } })).toBe(
        'Hall shape must be SQUARE or CIRCLE.',
      );
    });

    it('normalises case and whitespace', () => {
      accepts({ hall: { ...squareHall(), shape: '  square ' } });
      accepts({ hall: { ...circleHall(), shape: 'Circle' } });
    });

    it('ORDER: a bad shape is reported BEFORE a blank name (Java :427 precedes :434)', () => {
      expect(messageOf({ hall: { name: '', shape: 'HEXAGON', width: 40, length: 40 } })).toBe(
        'Hall shape must be SQUARE or CIRCLE.',
      );
    });
  });

  it.each([[null], [undefined], [''], ['   ']])('BR-04 hall name required: %p', (name) => {
    expect(messageOf({ hall: { ...squareHall(), name } })).toBe('Hall name is required.');
  });

  describe('BR-05 rectangular hall dimensions', () => {
    it.each([
      [0, 40],
      [40, 0],
      [-1, 40],
      [null, 40],
      [40, undefined],
    ])('rejects width=%p length=%p', (width, length) => {
      expect(messageOf({ hall: { ...squareHall(), width, length } })).toBe(
        'Hall width and length must be greater than 0.',
      );
    });

    it('does not look at the radius of a rectangular hall', () => {
      accepts({ hall: { ...squareHall(), radius: -5 } });
    });
  });

  describe('BR-06 circular hall radius', () => {
    it.each([[0], [-3], [null], [undefined]])('rejects radius=%p', (radius) => {
      expect(messageOf({ hall: { ...circleHall(), radius } })).toBe(
        'Hall radius must be greater than 0.',
      );
    });

    it('does not look at width/length of a circular hall', () => {
      accepts({ hall: { ...circleHall(), width: -1, length: -1 } });
    });
  });

  it('BR-07 zero stalls is valid — null, missing or empty', () => {
    accepts({ hall: squareHall(), stalls: null });
    accepts({ hall: squareHall() });
    accepts({ hall: squareHall(), stalls: [] });
  });

  it('BR-08 null stall element', () => {
    expect(messageOf({ hall: squareHall(), stalls: [stall(), null] })).toBe(
      'Stall at index 1 is null.',
    );
  });

  it.each([['width'], ['length'], ['height'], ['posX'], ['posZ']])(
    'BR-09 non-finite %s',
    (field) => {
      expect(messageOf({ hall: squareHall(), stalls: [stall({ [field]: Infinity })] })).toBe(
        'Invalid numeric value in stall at index 0.',
      );
      expect(messageOf({ hall: squareHall(), stalls: [stall({ [field]: NaN })] })).toBe(
        'Invalid numeric value in stall at index 0.',
      );
    },
  );

  describe('BR-10 stall dimensions', () => {
    it.each([['width'], ['length'], ['height']])('rejects zero / negative / null %s', (field) => {
      for (const value of [0, -1, null]) {
        expect(
          messageOf({ hall: squareHall(), stalls: [stall(), stall({ posX: 8, [field]: value })] }),
        ).toBe('Invalid stall dimensions at index 1.');
      }
    });
  });

  describe('BR-11 hall boundary', () => {
    it('rectangular: message carries index, name and Java-formatted doubles', () => {
      expect(
        messageOf({ hall: squareHall(), stalls: [stall({ name: 'Cafe', posX: -8, posZ: 18 })] }),
      ).toBe('Stall 0 (Cafe) is outside hall boundary. Center X=-8.0, Z=18.0');
    });

    it('prints fractional coordinates as Java does', () => {
      expect(messageOf({ hall: squareHall(), stalls: [stall({ posX: 17.75, posZ: 0 })] })).toBe(
        'Stall 0 (Shop) is outside hall boundary. Center X=17.75, Z=0.0',
      );
    });

    it('a blank stall name is shown as "Shop"', () => {
      expect(messageOf({ hall: squareHall(), stalls: [stall({ name: '  ', posX: 30 })] })).toBe(
        'Stall 0 (Shop) is outside hall boundary. Center X=30.0, Z=0.0',
      );
    });

    it('the name in the message is NOT trimmed (Java safeName)', () => {
      expect(messageOf({ hall: squareHall(), stalls: [stall({ name: ' Cafe ', posX: 30 })] })).toBe(
        'Stall 0 ( Cafe ) is outside hall boundary. Center X=30.0, Z=0.0',
      );
    });

    it('circular: conservative half-diagonal rule', () => {
      expect(messageOf({ hall: circleHall(), stalls: [stall({ posX: 17 })] })).toBe(
        'Stall 0 (Shop) is outside hall boundary. Center X=17.0, Z=0.0',
      );
    });

    it('accepts a stall flush against the wall', () => {
      accepts({ hall: squareHall(), stalls: [stall({ posX: 17.5, posZ: -17.5 })] });
    });
  });

  describe('BR-12 gate side', () => {
    it('rejects an unknown value', () => {
      expect(messageOf({ hall: squareHall(), stalls: [stall({ gateSide: 'UP' })] })).toBe(
        'gateSide must be FRONT, BACK, LEFT or RIGHT.',
      );
    });

    it.each([[null], [undefined], [''], ['  '], ['left'], [' Back ']])('accepts %p', (gateSide) => {
      accepts({ hall: squareHall(), stalls: [stall({ gateSide })] });
    });
  });

  describe('BR-13 overlap', () => {
    it('message names both stalls with their indexes', () => {
      expect(
        messageOf({
          hall: squareHall(),
          stalls: [
            stall({ name: 'Alpha' }),
            stall({ name: 'Beta', posX: 10 }),
            stall({ name: 'Gamma', posX: 12 }),
          ],
        }),
      ).toBe('Stall 2 (Gamma) overlaps stall 1 (Beta).');
    });

    it('edge-touching stalls are valid', () => {
      accepts({ hall: squareHall(), stalls: [stall(), stall({ posX: 5 }), stall({ posZ: 5 })] });
    });
  });

  describe('rule order inside the stall loop', () => {
    it('dimensions (BR-10) before boundary (BR-11)', () => {
      expect(messageOf({ hall: squareHall(), stalls: [stall({ width: 0, posX: 99 })] })).toBe(
        'Invalid stall dimensions at index 0.',
      );
    });

    it('boundary (BR-11) before gate (BR-12)', () => {
      expect(
        messageOf({ hall: squareHall(), stalls: [stall({ posX: 99, gateSide: 'UP' })] }),
      ).toMatch(/is outside hall boundary/);
    });

    it('gate (BR-12) before overlap (BR-13)', () => {
      expect(messageOf({ hall: squareHall(), stalls: [stall(), stall({ gateSide: 'UP' })] })).toBe(
        'gateSide must be FRONT, BACK, LEFT or RIGHT.',
      );
    });

    it('an earlier stall problem wins over a later one', () => {
      expect(
        messageOf({ hall: squareHall(), stalls: [stall({ height: 0 }), stall({ posX: 99 })] }),
      ).toBe('Invalid stall dimensions at index 0.');
    });

    it('gate (BR-12) before openSides entries', () => {
      expect(
        messageOf({
          hall: squareHall(),
          stalls: [stall({ gateSide: 'UP', openSides: ['UP'] })],
        }),
      ).toBe('gateSide must be FRONT, BACK, LEFT or RIGHT.');
    });
  });

  describe('openSides entries', () => {
    it('rejects an invalid entry', () => {
      expect(
        messageOf({ hall: squareHall(), stalls: [stall({ openSides: ['FRONT', 'UP'] })] }),
      ).toBe('openSides entries must be FRONT, BACK, LEFT or RIGHT.');
    });

    it('rejects non-string entries', () => {
      expect(messageOf({ hall: squareHall(), stalls: [stall({ openSides: [7] })] })).toBe(
        'openSides entries must be FRONT, BACK, LEFT or RIGHT.',
      );
    });

    it('accepts any valid combination of 1-4 sides', () => {
      accepts({ hall: squareHall(), stalls: [stall({ openSides: ['FRONT'] })] });
      accepts({ hall: squareHall(), stalls: [stall({ openSides: ['FRONT', 'RIGHT'] })] });
      accepts({
        hall: squareHall(),
        stalls: [stall({ openSides: ['FRONT', 'BACK', 'LEFT', 'RIGHT'] })],
      });
    });

    it('accepts an absent, null or empty list (falls back to gateSide)', () => {
      accepts({ hall: squareHall(), stalls: [stall()] });
      accepts({ hall: squareHall(), stalls: [stall({ openSides: null })] });
      accepts({ hall: squareHall(), stalls: [stall({ openSides: [] })] });
    });
  });
});

describe('normalizeShape / normalizeGate', () => {
  it('return the normalised value', () => {
    expect(normalizeShape(' circle ')).toBe('CIRCLE');
    expect(normalizeGate(' right ')).toBe('RIGHT');
    expect(normalizeGate(null)).toBe('FRONT');
  });
});
