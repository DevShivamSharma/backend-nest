import { Environment, validateEnv } from './env.validation';

const complete = {
  NODE_ENV: 'test',
  PORT: '8080',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'stall_designer_db',
  DATABASE_USER: 'postgres',
  DATABASE_PASSWORD: 'irrelevant-test-value',
  CORS_ORIGINS: 'http://localhost:4200',
  JWT_ACCESS_SECRET: 'a-test-secret-that-is-long-enough-to-pass',
};

describe('validateEnv', () => {
  it('accepts a complete environment and coerces numeric strings', () => {
    const result = validateEnv(complete);

    expect(result.NODE_ENV).toBe(Environment.Test);
    expect(result.PORT).toBe(8080);
    expect(result.DATABASE_PORT).toBe(5432);
  });

  it('applies defaults for every optional variable', () => {
    const result = validateEnv({
      DATABASE_HOST: 'localhost',
      DATABASE_NAME: 'stall_designer_db',
      DATABASE_USER: 'postgres',
      DATABASE_PASSWORD: 'irrelevant-test-value',
      JWT_ACCESS_SECRET: 'a-test-secret-that-is-long-enough-to-pass',
    });

    expect(result.PORT).toBe(8080);
    expect(result.DATABASE_PORT).toBe(5432);
    expect(result.DATABASE_POOL_SIZE).toBe(10);
    expect(result.CORS_ORIGINS).toBe('http://localhost:4200');
    expect(result.APP_PUBLIC_URL).toBe('http://localhost:4200');
    expect(result.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(result.REFRESH_TOKEN_TTL_DAYS).toBe(14);
    expect(result.NODE_ENV).toBe(Environment.Development);
  });

  it.each([
    ['DATABASE_HOST'],
    ['DATABASE_NAME'],
    ['DATABASE_USER'],
    ['DATABASE_PASSWORD'],
    ['JWT_ACCESS_SECRET'],
  ])('fails loudly and names the missing variable: %s', (missing) => {
    const partial: Record<string, unknown> = { ...complete };
    delete partial[missing];

    expect(() => validateEnv(partial)).toThrow(new RegExp(missing));
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnv({ ...complete, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects a short access-token secret', () => {
    expect(() => validateEnv({ ...complete, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...complete, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('never includes a variable value in the error message', () => {
    const secret = 'super-secret-password-value';

    // An empty host is invalid, so validation fails while a valid password is present. The
    // thrown message must not carry any value through.
    expect(() =>
      validateEnv({ ...complete, DATABASE_HOST: '', DATABASE_PASSWORD: secret }),
    ).toThrow();

    try {
      validateEnv({ ...complete, DATABASE_HOST: '', DATABASE_PASSWORD: secret });
      fail('expected validateEnv to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain('DATABASE_HOST');
    }
  });
});
