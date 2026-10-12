/** One captured payment of the event, as the ledger needs it. Amounts in paise. */
export interface PaymentLine {
  amountPaise: number;
  /** Razorpay's fee; null when it was never reported (counts as 0). */
  feePaise: number | null;
  /** Refunds Razorpay has processed. */
  refundedPaise: number;
  /** Refunds requested or being sent: not money back yet, but not settled either. */
  pendingRefundPaise: number;
}

export interface SettlementFigures {
  grossPaise: number;
  refundedPaise: number;
  gatewayFeePaise: number;
  platformFeePercent: number;
  platformFeePaise: number;
  netPayablePaise: number;
}

/**
 * docs/15 §6.4: net = gross − refunds − gateway fee − platform fee. The platform fee is a percent
 * of what the event kept after refunds, rounded half up to the whole paisa. It is worked in
 * integers (basis points, BigInt) so no float ever touches money: 2.5 % of 1,23,457 paise is
 * (123457 × 250 + 5000) div 10000 = 3086 paise.
 */
export function settlementFigures(
  lines: readonly PaymentLine[],
  platformFeePercent: number,
): SettlementFigures {
  const sum = (pick: (line: PaymentLine) => number) =>
    lines.reduce((total, line) => total + pick(line), 0);
  const grossPaise = sum((l) => l.amountPaise);
  const refundedPaise = sum((l) => l.refundedPaise);
  const gatewayFeePaise = sum((l) => l.feePaise ?? 0);
  const kept = grossPaise - refundedPaise;
  const basisPoints = Math.round(platformFeePercent * 100);
  const platformFeePaise = Number((BigInt(kept) * BigInt(basisPoints) + 5000n) / 10000n);
  return {
    grossPaise,
    refundedPaise,
    gatewayFeePaise,
    platformFeePercent,
    platformFeePaise,
    netPayablePaise: kept - gatewayFeePaise - platformFeePaise,
  };
}
