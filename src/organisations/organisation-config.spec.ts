import { RESERVED_SLUGS, SLUG_PATTERN } from './organisation-config';

describe('organisation slugs', () => {
  it.each(['itpo', 'yashobhoomi', 'jio-world-centre', 'hall5-expo'])('accepts %s', (slug) => {
    expect(SLUG_PATTERN.test(slug)).toBe(true);
  });

  it.each(['ab', '1itpo', 'itpo-', 'it--po', 'ITPO', 'it_po', 'a'.repeat(41)])(
    'rejects %s',
    (slug) => {
      expect(SLUG_PATTERN.test(slug)).toBe(false);
    },
  );

  it('reserves the words the app uses as its first path segment', () => {
    for (const word of ['admin', 'api', 'invalid-link', 'login']) {
      expect(RESERVED_SLUGS.has(word)).toBe(true);
    }
  });
});
