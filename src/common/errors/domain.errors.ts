/**
 * Domain errors.
 *
 * These carry no HTTP concern. `AllExceptionsFilter` is the only place that knows how they map
 * onto status codes, which keeps `LayoutService` free of HTTP imports (docs/09-decision-log.md
 * ADR-008) — the same separation the Java had, where `LayoutService` threw
 * `IllegalArgumentException` and `GlobalExceptionHandler` decided it meant 400.
 */
export abstract class DomainError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * The role played by `IllegalArgumentException` in the Java service.
 *
 * Maps to HTTP 400 with the message passed through verbatim. The message text is contract: the
 * React app renders `e.response.data.message` directly (frontend/src/App.js:575-577), so these
 * strings must match the Java originals character for character
 * (docs/04-business-rules.md BR-01 … BR-13).
 *
 * Note this is also what a missing layout raises — the Java returned 400, not 404, and that is
 * preserved deliberately (ADR-003).
 */
export class BadRequestDomainError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * The role played by `DataIntegrityViolationException`.
 *
 * Maps to HTTP 409 with the fixed message the Java used
 * (GlobalExceptionHandler.java:23-24).
 */
export class DataIntegrityDomainError extends DomainError {
  constructor(message: string = DataIntegrityDomainError.DEFAULT_MESSAGE) {
    super(message);
  }

  static readonly DEFAULT_MESSAGE =
    'Database constraint error. Check the existing database schema and required columns.';
}
