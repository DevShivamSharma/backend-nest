import { Environment, validateEnv } from './env.validation';

const complete = {
  NODE_ENV: 'test',
  PORT: '8080',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'stall_designer_db',
  DATABASE_USER: 'postgres',
  DATABASE_PASSWORD: 'irrelevant-test-value',
  CORS_ORIGINS: 'http://localhost:3000',
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
    });

    expect(result.PORT).toBe(8080);
    expect(result.DATABASE_PORT).toBe(5432);
    expect(result.DATABASE_POOL_SIZE).toBe(10);
    expect(result.CORS_ORIGINS).toBe('http://localhost:3000');
    expect(result.MAX_STALLS_PER_LAYOUT).toBe(2000);
    expect(result.NODE_ENV).toBe(Environment.Development);
  });

  it.each([
    ['DATABASE_HOST'],
    ['DATABASE_NAME'],
    ['DATABASE_USER'],
    ['DATABASE_PASSWORD'],
  ])('fails loudly and names the missing variable: %s', (missing) => {
    const partial: Record<string, unknown> = { ...complete };
    delete partial[missing];

    expect(() => validateEnv(partial)).toThrow(new RegExp(missing));
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnv({ ...complete, PORT: '70000' })).toThrow(/PORT/);
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
