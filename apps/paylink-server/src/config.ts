export const config = {
  port: process.env.PORT || 3000,
  baseUrl: process.env.BASE_URL || "http://localhost:3000",
  merchantAddress:
    process.env.MERCHANT_ADDRESS ||
    "0x0000000000000000000000000000000000000000",
  network: (process.env.X402_NETWORK || "base-sepolia") as "base-sepolia",
  streamPriceUSDC: process.env.STREAM_PRICE_USDC || "0.01",

  // Legacy JWT settings (still used by wrap API)
  jwtSecret: process.env.JWT_SECRET || "your-secret-key-change-in-production",
  jwtTTL: parseInt(process.env.JWT_TTL_SECONDS || "900", 10),

  // Deferred payment scheme settings (EIP-712 signature verification only)
  // Asset address (USDC on base-sepolia)
  assetAddress:
    process.env.ASSET_ADDRESS ||
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  // Step amount per minute in atomic units (0.01 USDC = 10000 units with 6 decimals)
  stepAmount: process.env.STEP_AMOUNT || "10000",
  // Voucher renewal interval in seconds
  voucherTimeWindow: parseInt(process.env.VOUCHER_TIME_WINDOW || "60", 10),
};

// Private IP ranges to block (SSRF protection)
const PRIVATE_IP_PATTERNS = [
  /^127\./, // 127.0.0.0/8 - localhost
  /^10\./, // 10.0.0.0/8 - private
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12 - private
  /^192\.168\./, // 192.168.0.0/16 - private
  /^169\.254\./, // 169.254.0.0/16 - link-local (AWS metadata)
  /^0\./, // 0.0.0.0/8
  /^\[::\]/, // IPv6 localhost
  /^\[::1\]/, // IPv6 localhost
  /^\[fe80:/, // IPv6 link-local
  /^\[fc00:/, // IPv6 unique local
];

export function isUpstreamAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = parsed.hostname;
    if (hostname === "localhost" || hostname === "0.0.0.0") {
      return false;
    }

    if (PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname))) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export type StreamKind = "hls" | "dash" | "progressive";

export function detectStreamKind(url: string): StreamKind | null {
  try {
    const pathname = new URL(url).pathname.toLowerCase();

    if (pathname.endsWith(".m3u8")) return "hls";
    if (pathname.endsWith(".mpd")) return "dash";
    if (
      pathname.endsWith(".mp4") ||
      pathname.endsWith(".mp3") ||
      pathname.endsWith(".webm") ||
      pathname.endsWith(".ogg") ||
      pathname.endsWith(".m4a") ||
      pathname.endsWith(".aac")
    ) {
      return "progressive";
    }

    return null;
  } catch {
    return null;
  }
}
