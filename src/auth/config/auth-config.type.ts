export type AuthConfig = {
  /** ITPO's own JWT secret, so their apps can verify the tokens issued here. */
  secret?: string;
  /** How long an access token lives, in ITPO's format ("240m"). */
  expires?: string;
  refreshSecret?: string;
  /** How long a refresh token lives, e.g. "7d". */
  refreshExpires?: string;
};
