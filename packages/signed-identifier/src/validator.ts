import { verifyMessage } from "ethers";
import type { CSI, CSIOptions } from "./types";

const DELIMITER = "\x1F"; // 0x1F separator

/**
 * Parse CSI from base64-encoded JSON header
 * Header format: Signed-Identifier: <base64(json)>
 */
export function parseCSI(headerValue: string): CSI {
  try {
    const decoded = Buffer.from(headerValue, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);

    if (
      !parsed.resource ||
      typeof parsed.resource !== "string" ||
      typeof parsed.expiry !== "number" ||
      parsed.curve !== "secp256k1" ||
      !parsed.signature ||
      typeof parsed.signature !== "string"
    ) {
      throw new Error("Invalid CSI format");
    }

    return {
      resource: parsed.resource,
      expiry: parsed.expiry,
      curve: parsed.curve,
      signature: parsed.signature,
    };
  } catch (err) {
    throw new Error(`Failed to parse CSI: ${err}`);
  }
}

/**
 * Construct the message that was signed
 * Format: UTF8(resource) || 0x1F || DECIMAL(expiry)
 */
export function constructCSIMessage(resource: string, expiry: number): string {
  return `${resource}${DELIMITER}${expiry}`;
}

/**
 * Recover signer address from CSI signature
 * Also validates freshness
 * Returns the recovered signer address (checksummed)
 */
export function recoverCSISigner(csi: CSI, options: CSIOptions = {}): string {
  const { maxSkewSeconds = 60, nowOverride } = options;
  const now = nowOverride ?? Math.floor(Date.now() / 1000);

  // Check freshness: now < expiry ≤ now + maxSkewSeconds
  if (csi.expiry <= now) {
    throw new Error("CSI expired");
  }

  if (csi.expiry > now + maxSkewSeconds) {
    throw new Error(`CSI expiry too far in future (max ${maxSkewSeconds}s)`);
  }

  // Only secp256k1 supported
  if (csi.curve !== "secp256k1") {
    throw new Error(`Unsupported curve: ${csi.curve}`);
  }

  // Construct message and recover signer
  const message = constructCSIMessage(csi.resource, csi.expiry);

  try {
    const signerAddress = verifyMessage(message, csi.signature);
    return signerAddress; // ethers returns checksummed address
  } catch (err) {
    throw new Error(`Invalid CSI signature: ${err}`);
  }
}

/**
 * Validate that CSI resource matches the requested URL
 * Normalizes both URLs before comparison
 */
export function validateCSIResource(csi: CSI, requestUrl: string): void {
  const normalizeUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      // Normalize: lowercase host, keep path/query/hash
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${
        parsed.pathname
      }${parsed.search}${parsed.hash}`;
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
  };

  const normalizedCSI = normalizeUrl(csi.resource);
  const normalizedRequest = normalizeUrl(requestUrl);

  if (normalizedCSI !== normalizedRequest) {
    throw new Error(
      `CSI resource mismatch: expected ${normalizedRequest}, got ${normalizedCSI}`
    );
  }
}
