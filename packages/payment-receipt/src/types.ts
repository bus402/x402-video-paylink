/**
 * Payment Receipt structure
 * This is the permanent payment proof
 */
export interface PaymentReceipt {
  /** Issuer (payment provider URL) */
  iss: string;
  /** Subject (payer wallet address, 0x-prefixed) */
  sub: string;
  /** SHA256 hash of the PaymentRequirements bytes */
  req: string;
  /** Issued at (Unix timestamp in seconds) */
  iat: number;
  /** Scope - array of path patterns this JWT is valid for */
  scope: string[];
}

/**
 * Proof-carrying Receipt
 * Includes on-chain transaction reference for auditability
 */
export interface ProofCarryingReceipt extends PaymentReceipt {
  /** On-chain payment transaction hash (0x-prefixed) */
  txHash: string;
}

/**
 * Union type for both receipt variants
 */
export type Receipt = PaymentReceipt | ProofCarryingReceipt;

/**
 * Type guard to check if receipt is proof-carrying
 */
export function isProofCarryingReceipt(
  receipt: Receipt
): receipt is ProofCarryingReceipt {
  return "txHash" in receipt && typeof receipt.txHash === "string";
}
