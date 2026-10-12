import { IsString, Length } from 'class-validator';

import { Trim } from '../../common/validation';

/** The bank transfer to the payee of a closed settlement, recorded by hand. */
export class PayoutDto {
  @Trim()
  @IsString()
  @Length(2, 160)
  payeeName!: string;

  /** Account name, number, IFSC, bank: free text, as the payee gave them (Q10). */
  @Trim()
  @IsString()
  @Length(5, 1000)
  bankDetails!: string;

  /** The bank's reference for the transfer (UTR). */
  @Trim()
  @IsString()
  @Length(3, 120)
  reference!: string;
}
