/**
 * Client Signed Identifier (CSI)
 *
 * A client-provided header that proves the client controls a specific wallet
 * and is requesting a specific resource within a time window.
 */
export interface CSI {
  /** Full URL of the resource being requested */
  resource: string;
  /** Unix timestamp (seconds) when this CSI expires */
  expiry: number;
  /** Elliptic curve used for signing (currently only secp256k1) */
  curve: "secp256k1";
  /** Hex-encoded signature (0x-prefixed) */
  signature: string;
}

/**
 * CSI validation options
 */
export interface CSIOptions {
  /** Maximum allowed clock skew in seconds (default: 60) */
  maxSkewSeconds?: number;
  /** Current time override for testing (Unix timestamp in seconds) */
  nowOverride?: number;
}
