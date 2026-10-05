/** Exact decimal multiplication followed by half-up rounding to paise. No intermediate float product. */
export function moneyProduct(a: number, b: number, divisor = 1): number {
  const decimal = (v: number): [bigint, number] => {
    const [coefficient, exponent = '0'] = v.toString().split('e');
    const [whole, fraction = ''] = coefficient.split('.');
    return [BigInt(whole + fraction), fraction.length - Number(exponent)];
  };
  const [aa, ap] = decimal(a), [bb, bp] = decimal(b);
  const scale = ap + bp - 2;
  const numerator = aa * bb * (scale < 0 ? 10n ** BigInt(-scale) : 1n);
  const denominator = BigInt(divisor) * (scale > 0 ? 10n ** BigInt(scale) : 1n);
  return Number((numerator * 2n + denominator) / (denominator * 2n)) / 100;
}
