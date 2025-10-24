import { Request, Response, NextFunction } from "express";
import { Address, getAddress } from "viem";
import { exact } from "x402/schemes";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { PaymentReceipt } from "@x402-video-paylink/payment-receipt";
import {
  computeRoutePatterns,
  findMatchingPaymentRequirements,
  findMatchingRoute,
  processPriceToAtomicAmount,
  toJsonSafe,
} from "x402/shared";
import {
  FacilitatorConfig,
  ERC20TokenAmount,
  PaymentPayload,
  PaymentRequirements,
  Resource,
  RoutesConfig,
  settleResponseHeader,
  SupportedEVMNetworks,
} from "x402/types";
import { useFacilitator } from "x402/verify";
import { PAYWALL_TEMPLATE } from "@x402-video-paylink/paywall/gen/template";

interface JWTPaymentOptions {
  merchantAddress: string;
  routes: RoutesConfig;
  facilitator?: FacilitatorConfig;
}

/**
 * Creates a middleware that combines x402 payment verification with JWT issuance
 *
 * Flow:
 * 1. Check for JWT in Authorization header → verify → allow access
 * 2. No JWT → delegate to x402 payment flow (custom implementation)
 * 3. Intercept res.setHeader to detect successful settlement
 * 4. When X-PAYMENT-RESPONSE is set → issue JWT
 */
export function createJWTExactMiddleware(options: JWTPaymentOptions) {
  const { merchantAddress, routes, facilitator } = options;
  const { verify, settle } = useFacilitator(facilitator);
  const x402Version = 1;

  // Pre-compile route patterns to regex
  const routePatterns = computeRoutePatterns(routes);

  console.log(
    "[JWT-PAYMENT] Creating middleware with routes:",
    JSON.stringify(routes)
  );

  return async (req: Request, res: Response, next: NextFunction) => {
    console.log(`[JWT-PAYMENT] ${req.method} ${req.path}`);

    // 1. Check for existing JWT
    const authHeader = req.header("Authorization");
    console.log(
      `[JWT-PAYMENT] Authorization header:`,
      authHeader ? "present" : "missing"
    );

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      try {
        const receipt = jwt.verify(token, config.jwtSecret) as PaymentReceipt;

        // Build current request full URL using config.baseUrl for security
        // This prevents header injection attacks and ensures consistency with JWT issuance
        const currentUrl = `${config.baseUrl}${req.path}`;
        console.log(`[JWT-PAYMENT] Current URL: ${currentUrl}`);
        console.log(`[JWT-PAYMENT] JWT scopes:`, receipt.scope);

        // Check if current URL matches any scope pattern
        const hasMatchingScope = receipt.scope.some((scopePattern) => {
          // Convert glob pattern to regex (e.g., /stream/xxx/* -> /stream/xxx/.*)
          const regexPattern = scopePattern.replace(/\*/g, ".*");
          const regex = new RegExp(`^${regexPattern}$`);
          return regex.test(currentUrl);
        });

        if (hasMatchingScope) {
          console.log(`[JWT-PAYMENT] JWT valid for this URL, allowing access`);
          return next();
        } else {
          console.log(
            `[JWT-PAYMENT] JWT scope doesn't match this URL, requiring new payment`
          );
        }
      } catch (err) {
        // JWT invalid, fall through to payment flow
        console.error("[JWT-PAYMENT] JWT verification failed:", err);
      }
    }

    // 2. Find matching route
    const matchingRoute = findMatchingRoute(
      routePatterns,
      req.path,
      req.method.toUpperCase()
    );
    console.log(
      `[JWT-PAYMENT] Matching route:`,
      matchingRoute ? "found" : "NOT FOUND"
    );
    if (!matchingRoute) {
      console.log(
        `[JWT-PAYMENT] No matching route, passing to next middleware`
      );
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

    // 3. Build payment requirements
    const atomicAmountForAsset = processPriceToAtomicAmount(price, network);
    if ("error" in atomicAmountForAsset) {
      throw new Error(atomicAmountForAsset.error);
    }
    const { maxAmountRequired, asset } = atomicAmountForAsset;

    const resourceUrl: Resource =
      resource ||
      (`${req.protocol}://${req.headers.host}${req.path}` as Resource);

    let paymentRequirements: PaymentRequirements[] = [];

    if (SupportedEVMNetworks.includes(network)) {
      paymentRequirements.push({
        scheme: "exact",
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
        extra: (asset as ERC20TokenAmount["asset"]).eip712,
      });
    } else {
      throw new Error(`Unsupported network: ${network}`);
    }

    // 4. Check if payment header exists
    const payment = req.header("X-PAYMENT");
    const userAgent = req.header("User-Agent") || "";
    const acceptHeader = req.header("Accept") || "";
    const isWebBrowser =
      acceptHeader.includes("text/html") && userAgent.includes("Mozilla");

    if (!payment) {
      if (isWebBrowser) {
        // Build x402 config with paymentRequirements
        const x402Config = {
          streamUrl: req.path, // Just the path, VideoPlayer will add baseUrl
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

        // Inject window.x402 config into our custom paywall template
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

    // 5. Decode and verify payment
    let decodedPayment: PaymentPayload;
    let payerAddress: string;
    try {
      decodedPayment = exact.evm.decodePayment(payment);
      decodedPayment.x402Version = x402Version;

      // Extract payer address
      if ("authorization" in decodedPayment.payload) {
        payerAddress = decodedPayment.payload.authorization.from;
      } else {
        throw new Error("SVM payment not supported yet");
      }
    } catch (error) {
      console.error(error);
      res.status(402).json({
        x402Version,
        error: error || "Invalid or malformed payment header",
        accepts: toJsonSafe(paymentRequirements),
      });
      return;
    }

    const selectedPaymentRequirements = findMatchingPaymentRequirements(
      paymentRequirements,
      decodedPayment
    );
    if (!selectedPaymentRequirements) {
      res.status(402).json({
        x402Version,
        error: "Unable to find matching payment requirements",
        accepts: toJsonSafe(paymentRequirements),
      });
      return;
    }

    try {
      const response = await verify(
        decodedPayment,
        selectedPaymentRequirements
      );
      if (!response.isValid) {
        res.status(402).json({
          x402Version,
          error: response.invalidReason,
          accepts: toJsonSafe(paymentRequirements),
          payer: response.payer,
        });
        return;
      }
    } catch (error) {
      console.error(error);
      res.status(402).json({
        x402Version,
        error,
        accepts: toJsonSafe(paymentRequirements),
      });
      return;
    }

    // 6. Intercept res.end to settle payment after response
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

    // 7. Proceed to next middleware/route handler
    next();

    // 8. If response is error, don't settle
    if (res.statusCode >= 400) {
      res.end = originalEnd;
      if (endArgs) {
        originalEnd(...(endArgs as Parameters<typeof res.end>));
      }
      return;
    }

    // 9. Settle payment and issue JWT
    try {
      const settleResponse = await settle(
        decodedPayment,
        selectedPaymentRequirements
      );
      const responseHeader = settleResponseHeader(settleResponse);
      res.setHeader("X-PAYMENT-RESPONSE", responseHeader);

      if (settleResponse.success) {
        // Extract stream ID from request path
        const streamId = req.path.match(/\/stream\/([^\/\.]+)/)?.[1];

        // Build scope with full URL pattern (no trailing slash before *)
        // This matches both /stream/{id}.m3u8 and /stream/{id}/segment.ts
        const scopePattern = streamId
          ? `${config.baseUrl}/stream/${streamId}*`
          : `${config.baseUrl}${req.path}`;

        // Issue JWT on successful settlement
        const receipt: PaymentReceipt = {
          iss: config.baseUrl,
          sub: payerAddress.toLowerCase(),
          req: req.originalUrl || req.url,
          iat: Math.floor(Date.now() / 1000),
          scope: [scopePattern],
        };

        console.log(`[JWT-PAYMENT] Issuing JWT with scope: ${scopePattern}`);

        const token = jwt.sign(receipt, config.jwtSecret, {
          expiresIn: config.jwtTTL,
        });

        res.setHeader("X-Receipt-Token", token);
      } else {
        res.status(402).json({
          x402Version,
          error: settleResponse.errorReason,
          accepts: toJsonSafe(paymentRequirements),
        });
        return;
      }
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.status(402).json({
          x402Version,
          error,
          accepts: toJsonSafe(paymentRequirements),
        });
        return;
      }
    } finally {
      res.end = originalEnd;
      if (endArgs) {
        originalEnd(...(endArgs as Parameters<typeof res.end>));
      }
    }
  };
}
