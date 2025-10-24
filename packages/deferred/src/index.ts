import { Address, getAddress, verifyTypedData, type WalletClient } from "viem";

// Deferred payment scheme constant
export const DEFERRED_SCHEME = "deferred" as const;

// Deferred payment voucher types
export interface DeferredVoucher {
  id: string; // Unique voucher ID
  seller: string; // Address (0x...)
  buyer: string; // Address (0x...)
  asset: string; // Token address (0x...)
  nonce: number; // Aggregation counter
  valueAggregate: string; // Total value in atomic units
  timestamp: number; // Unix timestamp
  expiry: number; // Unix timestamp
  chainId: number; // Network chain ID
}

export interface DeferredPaymentHeader {
  scheme: typeof DEFERRED_SCHEME;
  voucher: DeferredVoucher;
  signature: string; // EIP-712 signature (0x...)
}

// Stored voucher state for aggregation validation
export interface VoucherState {
  voucher: DeferredVoucher;
  signature: string;
  lastValidated?: number; // Server timestamp
}

// EIP-712 domain for voucher
export const getVoucherDomain = (chainId: number) => ({
  name: "X402 Deferred Payment",
  version: "1",
  chainId,
});

// EIP-712 types for voucher
export const VOUCHER_TYPES = {
  Voucher: [
    { name: "id", type: "string" },
    { name: "seller", type: "address" },
    { name: "buyer", type: "address" },
    { name: "asset", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "valueAggregate", type: "uint256" },
    { name: "timestamp", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "chainId", type: "uint256" },
  ],
} as const;

/**
 * Decode X-PAYMENT header for deferred scheme
 */
export function decodePayment(paymentHeader: string) {
  const parsed = JSON.parse(paymentHeader) as DeferredPaymentHeader;

  if (
    parsed.scheme !== DEFERRED_SCHEME ||
    !parsed.voucher ||
    !parsed.signature
  ) {
    throw new Error("Invalid deferred payment header");
  }

  return {
    x402Version: 1,
    scheme: DEFERRED_SCHEME,
    payload: {
      voucher: parsed.voucher,
      signature: parsed.signature,
    },
  };
}

/**
 * Verify EIP-712 voucher signature
 */
export async function verifyVoucherSignature(
  voucher: DeferredVoucher,
  signature: string
): Promise<boolean> {
  try {
    const valid = await verifyTypedData({
      address: getAddress(voucher.buyer) as Address,
      domain: getVoucherDomain(voucher.chainId),
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: {
        id: voucher.id,
        seller: getAddress(voucher.seller),
        buyer: getAddress(voucher.buyer),
        asset: getAddress(voucher.asset),
        nonce: BigInt(voucher.nonce),
        valueAggregate: BigInt(voucher.valueAggregate),
        timestamp: BigInt(voucher.timestamp),
        expiry: BigInt(voucher.expiry),
        chainId: BigInt(voucher.chainId),
      },
      signature: signature as `0x${string}`,
    });
    return valid;
  } catch (error) {
    console.error("[DEFERRED] Signature verification error:", error);
    return false;
  }
}

/**
 * Sign a voucher using EIP-712
 */
export async function signVoucher(
  walletClient: WalletClient,
  voucher: DeferredVoucher
): Promise<string> {
  const account = walletClient.account;
  if (!account) {
    throw new Error("No account found in wallet client");
  }

  const signature = await walletClient.signTypedData({
    account: account.address,
    domain: getVoucherDomain(voucher.chainId),
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: {
      id: voucher.id,
      seller: getAddress(voucher.seller),
      buyer: getAddress(voucher.buyer),
      asset: getAddress(voucher.asset),
      nonce: BigInt(voucher.nonce),
      valueAggregate: BigInt(voucher.valueAggregate),
      timestamp: BigInt(voucher.timestamp),
      expiry: BigInt(voucher.expiry),
      chainId: BigInt(voucher.chainId),
    },
  });

  return signature;
}

/**
 * Encode voucher and signature as X-PAYMENT header
 */
export function encodePayment(
  voucher: DeferredVoucher,
  signature: string
): string {
  const header: DeferredPaymentHeader = {
    scheme: DEFERRED_SCHEME,
    voucher,
    signature,
  };
  return JSON.stringify(header);
}

/**
 * Create a new voucher
 */
export function createVoucher(params: {
  id: string;
  seller: string;
  buyer: string;
  asset: string;
  nonce: number;
  valueAggregate: string;
  timestamp: number;
  expiry: number;
  chainId: number;
}): DeferredVoucher {
  return {
    id: params.id,
    seller: getAddress(params.seller),
    buyer: getAddress(params.buyer),
    asset: getAddress(params.asset),
    nonce: params.nonce,
    valueAggregate: params.valueAggregate,
    timestamp: params.timestamp,
    expiry: params.expiry,
    chainId: params.chainId,
  };
}
