import { Request, Response, NextFunction } from "express";
import { Address, getAddress } from "viem";
import { config } from "../config.js";
import {
  VoucherState,
  DEFERRED_SCHEME,
  decodePayment,
  verifyVoucherSignature,
} from "@x402-video-paylink/deferred";
import {
  computeRoutePatterns,
  processPriceToAtomicAmount,
  toJsonSafe,
  findMatchingRoute,
} from "x402/shared";
import {
  PaymentRequirements,
  Resource,
  RoutesConfig,
  SupportedEVMNetworks,
} from "x402/types";
import { PAYWALL_TEMPLATE } from "@x402-video-paylink/paywall/gen/template";

interface DeferredPaymentOptions {
  merchantAddress: string;
  routes: RoutesConfig;
}

// In-memory voucher store (voucher.id -> VoucherState)
const voucherStore = new Map<string, VoucherState>();

/**
 * Store voucher
 */
async function storeVoucher(voucherWithSignature: any) {
  const { signature, ...voucher } = voucherWithSignature;
  voucherStore.set(voucher.id, {
    voucher,
    signature,
    lastValidated: Date.now(),
  });
}

/**
 * Get payment requirements extra field for 402 response
 */
function getPaymentRequirementsExtra(payment: string | undefined) {
  // If X-PAYMENT header exists, we're in aggregation mode
  if (payment) {
    try {
      const decoded = decodePayment(payment);
      const { voucher, signature } = decoded.payload;

      return {
        type: "aggregation",
        voucher,
        signature,
      };
    } catch (error) {
      // Invalid payment, return new voucher requirements
    }
  }

  // Always return new voucher for first request
  return {
    type: "new",
    voucher: {
      id: `v-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    },
  };
}

/**
 * Creates a middleware for deferred payment verification
 *
 * Flow:
 * 1. Check for X-PAYMENT header with voucher
 * 2. Verify EIP-712 signature (no onchain interaction)
 * 3. Store voucher in local store
 * 4. No settlement (deferred scheme doesn't settle immediately)
 */
export function createDeferredPaymentMiddleware(
  options: DeferredPaymentOptions
) {
  const { merchantAddress, routes } = options;
  const x402Version = 1;

  // Pre-compile route patterns to regex
  const routePatterns = computeRoutePatterns(routes);

  console.log(
    "[DEFERRED] Creating middleware with routes:",
    JSON.stringify(routes)
  );

  return async (req: Request, res: Response, next: NextFunction) => {
    console.log(`[DEFERRED] ${req.method} ${req.path}`);

    // 1. Find matching route
    const matchingRoute = findMatchingRoute(
      routePatterns,
      req.path,
      req.method.toUpperCase()
    );
    console.log(
      `[DEFERRED] Matching route:`,
      matchingRoute ? "found" : "NOT FOUND"
    );
    if (!matchingRoute) {
      console.log(`[DEFERRED] No matching route, passing to next middleware`);
      return next();
    }

    const { price, network, config: routeConfig = {} } = matchingRoute.config;
    const {
      description,
      mimeType,
      maxTimeoutSeconds,
      inputSchema,
      outputSchema,
      customPaywallHtml,
      resource,
      discoverable,
    } = routeConfig;

    // 2. Build payment requirements
    const atomicAmountForAsset = processPriceToAtomicAmount(price, network);
    if ("error" in atomicAmountForAsset) {
      throw new Error(atomicAmountForAsset.error);
    }
    const { maxAmountRequired, asset } = atomicAmountForAsset;

    const resourceUrl: Resource =
      resource || (`${config.baseUrl}${req.path}` as Resource);

    const payment = req.header("X-PAYMENT");
    const chainId = network === "base-sepolia" ? 84532 : 8453;

    let paymentRequirements: PaymentRequirements[] = [];
    if (SupportedEVMNetworks.includes(network)) {
      const extra = getPaymentRequirementsExtra(payment);

      paymentRequirements.push({
        scheme: DEFERRED_SCHEME,
        network,
        maxAmountRequired,
        resource: resourceUrl,
        description: description ?? "",
        mimeType: mimeType ?? "",
        payTo: getAddress(merchantAddress as Address),
        maxTimeoutSeconds: maxTimeoutSeconds ?? 60,
        asset: getAddress(asset.address),
        outputSchema: {
          input: {
            type: "http",
            method: req.method.toUpperCase(),
            discoverable: discoverable ?? true,
            ...inputSchema,
          },
          output: outputSchema,
        },
        extra,
      } as any);
    } else {
      throw new Error(`Unsupported network: ${network}`);
    }

    // 3. Check if payment header exists
    const userAgent = req.header("User-Agent") || "";
    const acceptHeader = req.header("Accept") || "";
    const isWebBrowser =
      acceptHeader.includes("text/html") && userAgent.includes("Mozilla");

    if (!payment) {
      if (isWebBrowser) {
        // Build x402 config with paymentRequirements
        const x402Config = {
          streamUrl: req.path,
          merchantAddress: config.merchantAddress,
          amount: config.streamPriceUSDC,
          network: config.network,
          testnet: config.network === "base-sepolia",
          cdpClientKey: process.env.CDP_API_KEY || "",
          appName: "X402 Video",
          appLogo: undefined,
          paymentRequirements: toJsonSafe(paymentRequirements),
          currentUrl: req.originalUrl,
        };

        const html =
          customPaywallHtml ||
          PAYWALL_TEMPLATE.replace(
            "</head>",
            `<script>window.x402 = ${JSON.stringify(
              x402Config
            )};</script></head>`
          );

        res.status(402).send(html);
        return;
      }
      res.status(402).json({
        x402Version,
        error: "X-PAYMENT header is required",
        accepts: toJsonSafe(paymentRequirements),
      });
      return;
    }

    // 4. Decode and verify payment
    let decodedPayment: any;
    try {
      decodedPayment = decodePayment(payment);
    } catch (error) {
      console.error("[DEFERRED] Failed to decode payment:", error);
      res.status(402).json({
        x402Version,
        error: "Invalid or malformed X-PAYMENT header",
        accepts: toJsonSafe(paymentRequirements),
      });
      return;
    }

    const { voucher, signature } = decodedPayment.payload;

    // 5. Validate voucher requirements
    // Check seller matches
    if (voucher.seller.toLowerCase() !== merchantAddress.toLowerCase()) {
      console.log(`[DEFERRED] Seller mismatch`);
      res.status(402).json({
        x402Version,
        error: `Seller mismatch: expected ${merchantAddress}`,
        accepts: toJsonSafe(paymentRequirements),
      });
      return;
    }

    // Check asset matches
    if (voucher.asset.toLowerCase() !== config.assetAddress.toLowerCase()) {
      console.log(`[DEFERRED] Asset mismatch`);
      res.status(402).json({
        x402Version,
        error: `Asset mismatch: expected ${config.assetAddress}`,
        accepts: toJsonSafe(paymentRequirements),
      });
      return;
    }

    // Check chainId matches
    if (voucher.chainId !== chainId) {
      console.log(`[DEFERRED] ChainId mismatch`);
      res.status(402).json({
        x402Version,
        error: `ChainId mismatch: expected ${chainId}`,
        accepts: toJsonSafe(paymentRequirements),
      });
      return;
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (now > voucher.expiry) {
      console.log(`[DEFERRED] Voucher expired`);
      res.status(402).json({
        x402Version,
        error: "Voucher expired",
        accepts: toJsonSafe(paymentRequirements),
      });
      return;
    }

    // Check timestamp is reasonable
    if (voucher.timestamp > now + 60) {
      console.log(`[DEFERRED] Voucher timestamp too far in future`);
      res.status(402).json({
        x402Version,
        error: "Voucher timestamp invalid",
        accepts: toJsonSafe(paymentRequirements),
      });
      return;
    }

    // 6. Verify EIP-712 signature
    const valid = await verifyVoucherSignature(voucher, signature);
    if (!valid) {
      console.log("[DEFERRED] Signature verification failed");
      res.status(402).json({
        x402Version,
        error: "Invalid voucher signature",
        accepts: toJsonSafe(paymentRequirements),
      });
      return;
    }

    // 7. Check for aggregation or reuse
    const previousVoucher = voucherStore.get(voucher.id);
    if (previousVoucher) {
      const prev = previousVoucher.voucher;

      // Check if this is voucher reuse (same nonce) or aggregation (nonce++)
      if (voucher.nonce === prev.nonce) {
        // Voucher reuse: check if timestamp is within 20 seconds
        const timeDiff = now - prev.timestamp;
        if (timeDiff > 20) {
          console.log(
            `[DEFERRED] Voucher expired (${timeDiff}s > 20s), requesting aggregation`
          );

          // Update extra to request aggregation with current voucher
          const aggregationRequirements = [...paymentRequirements];
          aggregationRequirements[0] = {
            ...aggregationRequirements[0],
            extra: {
              type: "aggregation",
              voucher: prev,
              signature: previousVoucher.signature,
            },
          };

          res.status(402).json({
            x402Version,
            error: "Voucher timestamp expired, please aggregate",
            accepts: toJsonSafe(aggregationRequirements),
          });
          return;
        }

        // Voucher is still valid (< 20 seconds), allow reuse
        console.log(
          `[DEFERRED] Reusing voucher nonce=${voucher.nonce} (${timeDiff}s old)`
        );
        // Continue to allow access
      } else if (voucher.nonce !== prev.nonce + 1) {
        // Nonce must be either same or prev+1
        console.log(
          `[DEFERRED] Nonce mismatch: expected ${prev.nonce} or ${
            prev.nonce + 1
          }, got ${voucher.nonce}`
        );
        res.status(402).json({
          x402Version,
          error: `Nonce mismatch: expected ${prev.nonce + 1}`,
          accepts: toJsonSafe(paymentRequirements),
        });
        return;
      } else {
        // Nonce incremented (aggregation)
        // Check valueAggregate increased by stepAmount
        const expectedValue =
          BigInt(prev.valueAggregate) + BigInt(config.stepAmount);
        if (BigInt(voucher.valueAggregate) !== expectedValue) {
          console.log(`[DEFERRED] ValueAggregate mismatch`);
          res.status(402).json({
            x402Version,
            error: `ValueAggregate mismatch: expected ${expectedValue}`,
            accepts: toJsonSafe(paymentRequirements),
          });
          return;
        }

        // Check timestamp increased
        if (voucher.timestamp <= prev.timestamp) {
          console.log(`[DEFERRED] Timestamp must increase`);
          res.status(402).json({
            x402Version,
            error: "Timestamp must increase",
            accepts: toJsonSafe(paymentRequirements),
          });
          return;
        }

        // Check immutable fields
        if (
          voucher.id !== prev.id ||
          voucher.seller.toLowerCase() !== prev.seller.toLowerCase() ||
          voucher.buyer.toLowerCase() !== prev.buyer.toLowerCase() ||
          voucher.asset.toLowerCase() !== prev.asset.toLowerCase() ||
          voucher.chainId !== prev.chainId
        ) {
          console.log(`[DEFERRED] Immutable fields changed`);
          res.status(402).json({
            x402Version,
            error: "Immutable fields changed during aggregation",
            accepts: toJsonSafe(paymentRequirements),
          });
          return;
        }

        console.log(`[DEFERRED] Aggregation valid: nonce ${voucher.nonce}`);
      }
    } else {
      // First voucher for this ID
      if (voucher.nonce !== 0) {
        console.log(
          `[DEFERRED] First voucher must have nonce=0, got ${voucher.nonce}`
        );
        res.status(402).json({
          x402Version,
          error: "First voucher must have nonce=0",
          accepts: toJsonSafe(paymentRequirements),
        });
        return;
      }
      console.log(`[DEFERRED] New voucher: id ${voucher.id}`);
    }

    // 8. Store voucher state
    await storeVoucher({ ...voucher, signature });

    // 9. Intercept res.end to add Payment-Response header
    type EndArgs =
      | [cb?: () => void]
      | [chunk: any, cb?: () => void]
      | [chunk: any, encoding: BufferEncoding, cb?: () => void];

    const originalEnd = res.end.bind(res);
    let endArgs: EndArgs | null = null;

    res.end = function (...args: EndArgs) {
      endArgs = args;
      return res;
    };

    // 10. Proceed to next middleware/route handler
    next();

    // 11. If response is error, don't set Payment-Response
    if (res.statusCode >= 400) {
      res.end = originalEnd;
      if (endArgs) {
        originalEnd(...(endArgs as Parameters<typeof res.end>));
      }
      return;
    }

    // 12. Set Payment-Response header (no settlement in deferred scheme)
    res.setHeader(
      "X-PAYMENT-RESPONSE",
      JSON.stringify({
        scheme: DEFERRED_SCHEME,
        network: config.network,
        id: voucher.id,
        timestamp: Math.floor(Date.now() / 1000),
        success: true,
      })
    );

    console.log(`[DEFERRED] Request completed successfully`);

    res.end = originalEnd;
    if (endArgs) {
      originalEnd(...(endArgs as Parameters<typeof res.end>));
    }
  };
}
