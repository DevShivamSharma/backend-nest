import { formatJavaDouble } from './java-double';

describe('formatJavaDouble — matches Java Double.toString', () => {
  it.each([
    [0, '0.0'],
    [-0, '-0.0'],
    [16, '16.0'],
    [-8, '-8.0'],
    [1.5, '1.5'],
    [-17.25, '-17.25'],
    [0.001, '0.001'],
    [9999999, '9999999.0'],
    [1e7, '1.0E7'],
    [12345678.5, '1.23456785E7'],
    [0.0001, '1.0E-4'],
    [-2.5e-5, '-2.5E-5'],
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [-Infinity, '-Infinity'],
  ])('%p -> %s', (input, expected) => {
    expect(formatJavaDouble(input)).toBe(expected);
  });
});
