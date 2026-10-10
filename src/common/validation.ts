import { Transform } from 'class-transformer';
import { ValidateBy } from 'class-validator';

/** Trims surrounding whitespace from a string field before validation. */
export const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** Trims and lower-cases an email address, so lookups and uniqueness ignore case. */
export const NormaliseEmail = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );

/** Turns an empty or whitespace-only string into null, for optional text fields. */
export const EmptyToNull = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** An https URL, or a path on this site such as `/assets/logos/itpo.svg`. */
export const IMAGE_URL = /^(https:\/\/[^\s"'<>]+|\/[\w\-./]+)$/;

/** 10–128 characters. Length beats composition rules (NIST SP 800-63B). */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** Floor metres; halls are at most 2 km a side. */
export const MAX_COORD = 5000;

/** Every item is a point: two finite numbers within the floor's reach. */
export function IsPoints(message = 'A zone outline is a list of [x, y] points in metres.') {
  return ValidateBy({
    name: 'isPoints',
    validator: {
      validate: (value: unknown) =>
        Array.isArray(value) &&
        value.every(
          (p) =>
            Array.isArray(p) &&
            p.length === 2 &&
            p.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD),
        ),
      defaultMessage: () => message,
    },
  });
}
