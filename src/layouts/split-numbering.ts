/** Zero-based ordinal, Excel-style alphabetic suffix; identifiers are never parsed as sizes. */
export function splitSuffix(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Invalid split ordinal');
  let n = index + 1,
    result = '';
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}
