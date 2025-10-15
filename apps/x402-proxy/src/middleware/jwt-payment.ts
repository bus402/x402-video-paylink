import { Request, Response, NextFunction } from "express";
import { paymentMiddleware, type RoutesConfig } from "x402-express";
import { exact } from "x402/schemes";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { PaymentReceipt } from "@x402-video/payment-receipt";

interface JWTPaymentOptions {
  merchantAddress: string;
  routes: RoutesConfig;
}

/**
 * Creates a middleware that combines x402 payment verification with JWT issuance
 *
 * Flow:
 * 1. Check for JWT in Authorization header → verify → allow access
 * 2. No JWT → delegate to x402-express middleware
 * 3. Intercept res.setHeader to detect successful settlement
 * 4. When X-PAYMENT-RESPONSE is set → issue JWT
 */
export function createJWTPaymentMiddleware(options: JWTPaymentOptions) {
  const { merchantAddress, routes } = options;

  console.log(
    "[JWT-PAYMENT] Creating middleware with routes:",
    JSON.stringify(routes)
  );

  // Create the underlying x402 payment middleware
  const x402Middleware = paymentMiddleware(
    merchantAddress as `0x${string}`,
    routes
    // Note: customPaywallHtml is set in routes config
  );

  return async (req: Request, res: Response, next: NextFunction) => {
    console.log(`[JWT-PAYMENT] ${req.method} ${req.path}`);

    // 1. Check for existing JWT
    const authHeader = req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      try {
        jwt.verify(token, config.jwtSecret) as PaymentReceipt;
        // JWT valid, allow access
        return next();
      } catch (err) {
        // JWT invalid, fall through to payment flow
        console.error(err);
      }
    }

    // 2. Check if payment header exists
    const paymentHeader = req.header("X-PAYMENT");
    if (!paymentHeader) {
      // No payment, delegate to x402 which will return 402
      return x402Middleware(req, res, next);
    }

    // 3. Decode payment to extract payer address
    let payerAddress: string;
    try {
      const decodedPayment = exact.evm.decodePayment(paymentHeader);
      // Extract payer from authorization.from field
      if ("authorization" in decodedPayment.payload) {
        payerAddress = decodedPayment.payload.authorization.from;
      } else {
        // SVM payment, not supported yet
        return x402Middleware(req, res, next);
      }
    } catch (err) {
      // Invalid payment format, let x402 handle the error
      return x402Middleware(req, res, next);
    }

    // 4. Intercept res.setHeader to detect successful settlement
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = function (
      name: string,
      value: any
    ): ReturnType<typeof res.setHeader> {
      // When x402 sets X-PAYMENT-RESPONSE, settlement succeeded
      if (name === "X-PAYMENT-RESPONSE") {
        // Create JWT receipt
        const receipt: PaymentReceipt = {
          iss: config.baseUrl,
          sub: payerAddress.toLowerCase(), // Normalize address to lowercase
          req: req.originalUrl || req.url,
          iat: Math.floor(Date.now() / 1000),
        };

        const token = jwt.sign(receipt, config.jwtSecret, {
          expiresIn: config.jwtTTL,
        });

        // Set JWT header
        originalSetHeader.call(res, "X-Receipt-Token", token);
      }

      // Call original setHeader
      return originalSetHeader.call(res, name, value);
    };

    // 5. Delegate to x402 middleware
    return x402Middleware(req, res, next);
  };
}
