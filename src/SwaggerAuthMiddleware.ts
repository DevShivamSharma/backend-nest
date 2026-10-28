import { timingSafeEqual } from 'node:crypto';

/** Basic auth in front of the API docs. With no SWAGGER_USERNAME / SWAGGER_PASSWORD set, nobody gets in. */
export class SwaggerAuthMiddleware {
  static use(
    req: { headers: Record<string, string | undefined> },
    res: {
      setHeader: (n: string, v: string) => void;
      status: (c: number) => { send: (b: string) => void };
    },
    next: () => void,
  ) {
    const challenge = () => {
      res.setHeader('WWW-Authenticate', 'Basic realm="Swagger API"');
      return res.status(401).send('Authentication required');
    };

    const expectedUser = process.env.SWAGGER_USERNAME;
    const expectedPassword = process.env.SWAGGER_PASSWORD;
    const authHeader = req.headers.authorization;
    if (!expectedUser || !expectedPassword || !authHeader?.startsWith('Basic ')) {
      return challenge();
    }

    const [username, ...rest] = Buffer.from(authHeader.split(' ')[1], 'base64')
      .toString()
      .split(':');
    const same = (a: string, b: string) =>
      a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (!same(username, expectedUser) || !same(rest.join(':'), expectedPassword)) {
      return challenge();
    }

    next();
  }
}
