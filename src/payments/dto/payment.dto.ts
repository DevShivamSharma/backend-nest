import { IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

import { Trim } from '../../common/validation';

/** What Razorpay Checkout's success handler gives, under the names it gives them. */
export class VerifyPaymentDto {
  @Matches(/^order_\w{6,40}$/)
  razorpay_order_id!: string;

  @Matches(/^pay_\w{6,40}$/)
  razorpay_payment_id!: string;

  @Matches(/^[a-f0-9]{64}$/)
  razorpay_signature!: string;
}

/** A staff refund: all that is left of the payment, or the amount given. */
export class RefundDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  amountPaise?: number;

  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}
