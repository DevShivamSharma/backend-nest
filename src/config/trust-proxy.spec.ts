import { parseTrustProxy } from './app.config';

describe('parseTrustProxy', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['  ', false],
    ['false', false],
    ['FALSE', false],
    ['true', true],
    ['1', 1],
    ['2', 2],
    ['loopback, 10.0.0.0/8', 'loopback, 10.0.0.0/8'],
  ])('reads %p as %p', (input, expected) => {
    expect(parseTrustProxy(input)).toBe(expected);
  });
});
