export type AppConfig = {
  nodeEnv: string;
  name: string;
  workingDirectory: string;
  frontendDomain?: string;
  backendDomain: string;
  port: number;
  apiPrefix: string;
  /**
   * Express's `trust proxy`: how many proxies (a load balancer) sit in front, so the client's real
   * address is read from X-Forwarded-For. False when the API is reached directly.
   */
  trustProxy: boolean | number | string;
};
