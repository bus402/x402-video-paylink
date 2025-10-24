import express, { type Application } from "express";
import { createId } from "@paralleldrive/cuid2";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { config, isUpstreamAllowed, detectStreamKind } from "./config.js";
import type { Wrapped, WrapRequest, WrapResponse } from "./types.js";
import { fetchUpstream, getManifestRewriter, getContentType } from "./utils.js";
import { createJWTExactMiddleware } from "./middleware/jwt-exact.js";
import { createDeferredPaymentMiddleware } from "./middleware/deferred-payment.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const app: Application = express();
const wrapped = new Map<string, Wrapped>();

// Manifest (/stream/{id}.{ext}) uses exact scheme (one-time payment, returns JWT)
// Matches: /stream/abc.m3u8, /stream/xyz.mpd, /stream/foo.mp4
const exactPaymentMiddleware = createJWTExactMiddleware({
  merchantAddress: config.merchantAddress,
  routes: {
    "/stream/*.*": {
      price: config.streamPriceUSDC,
      network: config.network,
    },
  },
});

// Segments (/stream/{id}/{...}) use deferred scheme (voucher aggregation)
// Matches: /stream/abc/segment0.ts, /stream/abc/path/to/file.m3u8
const deferredPaymentMiddleware = createDeferredPaymentMiddleware({
  merchantAddress: config.merchantAddress,
  routes: {
    "/stream/**/*": {
      price: config.streamPriceUSDC,
      network: config.network,
    },
  },
});

app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-PAYMENT, Authorization"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-PAYMENT-RESPONSE"
  );

  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

// Root - Serve paylink UI
app.get("/", (_req, res) => {
  // Path works both locally (from src) and in Docker (from dist)
  // In local dev: src -> ../../packages/paylink-ui/index.html
  // In Docker: dist -> ../../packages/paylink-ui/index.html
  const htmlPath = path.join(
    __dirname,
    "../../../packages/paylink-ui/index.html"
  );
  res.sendFile(htmlPath);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// POST /wrap - Wrap a video URL
app.post("/wrap", (req, res) => {
  const body = req.body as WrapRequest;
  if (!body.url || typeof body.url !== "string") {
    return res.status(400).json({ error: 'Missing or invalid "url" field' });
  }

  // Check if upstream is allowed (SSRF protection)
  if (!isUpstreamAllowed(body.url)) {
    return res.status(403).json({
      error: "Upstream not allowed (private IPs blocked for security)",
    });
  }

  // Detect or validate stream kind
  const kind = detectStreamKind(body.url);
  if (!kind) {
    return res.status(400).json({
      error:
        "Cannot detect stream type. URL must end with .m3u8, .mpd, .mp4, .mp3, .webm, etc.",
    });
  }

  // Generate ID
  const id = createId();
  if (wrapped.has(id)) {
    return res.status(409).json({ error: "ID already exists" });
  }

  // Extract original extension for progressive streams
  const originalExt = (() => {
    if (kind === "progressive") {
      const match = body.url.match(/\.([a-z0-9]+)(\?|$)/i);
      return match ? match[1] : "mp4";
    }
  })();

  // Store wrapped stream info
  const wrappedStream: Wrapped = {
    id,
    originUrl: body.url,
    kind,
    createdAt: Date.now(),
    originalExt,
  };

  wrapped.set(id, wrappedStream);

  const wrappedUrl = (() => {
    if (kind === "hls") {
      return `${config.baseUrl}/stream/${id}.m3u8`;
    } else if (kind === "dash") {
      return `${config.baseUrl}/stream/${id}.mpd`;
    } else {
      // progressive
      return `${config.baseUrl}/stream/${id}.${originalExt}`;
    }
  })();

  const response: WrapResponse = { wrappedUrl };
  res.json(response);
});

// GET /stream/:id.:ext - Proxy main file (manifest or progressive stream)
app.get("/stream/:id.:ext", exactPaymentMiddleware, async (req, res) => {
  const { id, ext } = req.params;
  const stream = wrapped.get(id);
  if (!stream) {
    return res.status(404).json({ error: "Stream not found" });
  }

  // Verify extension matches stream kind
  if (stream.kind === "hls" && ext !== "m3u8") {
    return res
      .status(400)
      .json({ error: "Extension mismatch: expected .m3u8" });
  }

  if (stream.kind === "dash" && ext !== "mpd") {
    return res.status(400).json({ error: "Extension mismatch: expected .mpd" });
  }

  if (stream.kind === "progressive" && ext !== stream.originalExt) {
    return res
      .status(400)
      .json({ error: `Extension mismatch: expected .${stream.originalExt}` });
  }

  try {
    // For HLS/DASH manifests, we need to rewrite URLs
    if (stream.kind === "hls" || stream.kind === "dash") {
      // Fetch from origin (no range limiting for manifests)
      const upstreamRes = await fetchUpstream(
        stream.originUrl,
        req.headers as Record<string, string>
      );

      if (!upstreamRes.ok) {
        return res.status(upstreamRes.status).json({ error: "Upstream error" });
      }

      const contentType = getContentType(stream.kind);
      const body = await upstreamRes.text();

      const rewriter = getManifestRewriter(stream.kind);
      const rewritten = rewriter.rewrite(body, id, config.baseUrl);

      res.setHeader("Content-Type", contentType);
      res.setHeader("Access-Control-Allow-Origin", "*");

      // Prevent caching of manifest to ensure fresh JWT is used
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      res.send(rewritten);
      console.log(
        `[MANIFEST] ${stream.kind} manifest proxied: ${id} (${body.length} -> ${rewritten.length} bytes)`
      );
      return;
    }

    // Progressive stream - pipe through with range limiting
    {
      // Limit range requests to prevent excessive buffering (~10 seconds of video)
      // Assuming ~5 Mbps video = ~625 KB/s, 10 seconds = ~6.25 MB
      // Set limit to 10 MB to be safe
      const MAX_RANGE_BYTES = 10 * 1024 * 1024; // 10 MB

      // Parse and potentially limit the range request
      const rangeHeader = req.headers.range;
      let limitedRangeHeader: string | undefined = rangeHeader;

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const requestedEnd = match[2] ? parseInt(match[2], 10) : undefined;

          // If requestedEnd is specified and exceeds limit, constrain it
          if (requestedEnd !== undefined) {
            const maxEnd = start + MAX_RANGE_BYTES - 1;
            if (requestedEnd > maxEnd) {
              limitedRangeHeader = `bytes=${start}-${maxEnd}`;
              console.log(
                `[RANGE-LIMIT] ${id}: requested ${start}-${requestedEnd}, limited to ${start}-${maxEnd} (${
                  maxEnd - start + 1
                } bytes, max ${MAX_RANGE_BYTES})`
              );
            }
          } else {
            // If no end specified (e.g., "bytes=0-"), limit it
            const maxEnd = start + MAX_RANGE_BYTES - 1;
            limitedRangeHeader = `bytes=${start}-${maxEnd}`;
            console.log(
              `[RANGE-LIMIT] ${id}: requested ${start}- (open-ended), limited to ${start}-${maxEnd}`
            );
          }
        }
      }

      // Prepare headers with limited range
      const upstreamHeaders = { ...req.headers } as Record<string, string>;
      if (limitedRangeHeader) {
        upstreamHeaders.range = limitedRangeHeader;
      }

      // Fetch from origin with potentially limited range
      const upstreamRes = await fetchUpstream(stream.originUrl, upstreamHeaders);

      const contentType =
        upstreamRes.headers.get("content-type") ||
        getContentType(stream.kind, stream.originalExt);

      res.status(upstreamRes.status);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Access-Control-Allow-Origin", "*");

      // Forward relevant headers
      [
        "content-length",
        "content-range",
        "accept-ranges",
        "cache-control",
        "etag",
        "last-modified",
      ].forEach((header) => {
        const value = upstreamRes.headers.get(header);
        if (value) res.setHeader(header, value);
      });

      // Stream the response
      if (!upstreamRes.body) {
        res.end();
        return;
      }

      const reader = upstreamRes.body.getReader();
      const streamChunks = async (totalBytes: number = 0): Promise<number> => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            return totalBytes;
          }
          res.write(value);
          return streamChunks(totalBytes + value.length);
        } catch (err) {
          console.error(`[ERROR] Stream error for ${id}:`, err);
          res.end();
          return totalBytes;
        }
      };

      const bytesTransferred = await streamChunks();
      console.log(`[PROGRESSIVE] Streamed ${id}: ${bytesTransferred} bytes`);
    }
  } catch (err) {
    console.error(`[ERROR] Proxy error for ${id}:`, err);
    res.status(500).json({ error: "Proxy error" });
  }
});

// GET /stream/:id/* - Proxy segments/keys for HLS/DASH
app.get("/stream/:id/*", deferredPaymentMiddleware, async (req, res) => {
  const { id } = req.params;
  const segmentPath = (req.params as any)[0] as string; // Everything after /stream/:id/

  const stream = wrapped.get(id);
  if (!stream) {
    return res.status(404).json({ error: "Stream not found" });
  }

  try {
    // Reconstruct segment URL
    const segmentUrl =
      segmentPath.startsWith("http%3A") || segmentPath.startsWith("https%3A")
        ? decodeURIComponent(segmentPath)
        : (() => {
            const originUrl = new URL(stream.originUrl);
            const originBase =
              originUrl.origin +
              originUrl.pathname.substring(
                0,
                originUrl.pathname.lastIndexOf("/") + 1
              );
            return new URL(segmentPath, originBase).href;
          })();

    // Limit range requests for segments to prevent excessive buffering
    const MAX_RANGE_BYTES = 10 * 1024 * 1024; // 10 MB
    const rangeHeader = req.headers.range;
    let limitedRangeHeader: string | undefined = rangeHeader;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const requestedEnd = match[2] ? parseInt(match[2], 10) : undefined;

        if (requestedEnd !== undefined) {
          const maxEnd = start + MAX_RANGE_BYTES - 1;
          if (requestedEnd > maxEnd) {
            limitedRangeHeader = `bytes=${start}-${maxEnd}`;
            console.log(
              `[SEGMENT-RANGE-LIMIT] ${id}/${segmentPath.substring(0, 30)}: requested ${start}-${requestedEnd}, limited to ${start}-${maxEnd}`
            );
          }
        } else {
          const maxEnd = start + MAX_RANGE_BYTES - 1;
          limitedRangeHeader = `bytes=${start}-${maxEnd}`;
          console.log(
            `[SEGMENT-RANGE-LIMIT] ${id}/${segmentPath.substring(0, 30)}: requested ${start}- (open-ended), limited to ${start}-${maxEnd}`
          );
        }
      }
    }

    // Prepare headers with limited range
    const upstreamHeaders = { ...req.headers } as Record<string, string>;
    if (limitedRangeHeader) {
      upstreamHeaders.range = limitedRangeHeader;
    }

    // Fetch segment from origin with potentially limited range
    const upstreamRes = await fetchUpstream(segmentUrl, upstreamHeaders);

    // Stream the segment
    res.status(upstreamRes.status);

    // Forward headers
    const contentType =
      upstreamRes.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");

    [
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
      "etag",
      "last-modified",
    ].forEach((header) => {
      const value = upstreamRes.headers.get(header);
      if (value) res.setHeader(header, value);
    });

    if (!upstreamRes.body) {
      res.end();
      return;
    }

    const reader = upstreamRes.body.getReader();
    const streamSegment = async (totalBytes: number = 0): Promise<number> => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return totalBytes;
        }
        res.write(value);
        return streamSegment(totalBytes + value.length);
      } catch (err) {
        console.error(`[ERROR] Segment stream error for ${id}:`, err);
        res.end();
        return totalBytes;
      }
    };

    const bytesTransferred = await streamSegment();
    console.log(
      `[SEGMENT] ${id}/${segmentPath.substring(
        0,
        50
      )}... : ${bytesTransferred} bytes`
    );
  } catch (err) {
    console.error(`[ERROR] Segment proxy error for ${id}/${segmentPath}:`, err);
    res.status(500).json({ error: "Segment proxy error" });
  }
});
