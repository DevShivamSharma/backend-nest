/**
 * Formats a number the way Java's `Double.toString` does.
 *
 * Needed for exactly one reason: the BR-11 error message concatenates two doubles
 * (LayoutService.java:522-525), and the frontend shows that message verbatim. Java prints
 * `-8.0` where JavaScript prints `-8`, so without this the text would differ.
 *
 * Rules reproduced: whole numbers carry `.0`; magnitudes in [1e-3, 1e7) use plain decimal;
 * everything else uses Java's `1.0E10` style computerised scientific notation.
 */
export function formatJavaDouble(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';

  const magnitude = Math.abs(value);

  if (magnitude >= 1e-3 && magnitude < 1e7) {
    return Number.isInteger(value) ? value.toFixed(1) : String(value);
  }

  const [mantissa, exponent] = value.toExponential().split('e');
  const javaMantissa = mantissa.includes('.') ? mantissa : `${mantissa}.0`;

  return `${javaMantissa}E${Number(exponent)}`;
}
