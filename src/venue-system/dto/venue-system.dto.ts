import { IsBoolean, IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';

import { Trim } from '../../common/validation';

/** Where the organisation's published plans are pushed, and the secret that signs them. */
export class VenueIntegrationDto {
  @Trim()
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true, require_tld: false })
  @MaxLength(500)
  callbackUrl!: string;

  /** Write-only. Absent keeps the current secret; never trimmed, it is used byte for byte. */
  @IsOptional()
  @IsString()
  @Length(16, 256)
  secret?: string;

  @IsBoolean()
  enabled!: boolean;
}
