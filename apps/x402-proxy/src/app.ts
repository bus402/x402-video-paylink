import express, { type Application } from "express";
import { createId } from "@paralleldrive/cuid2";
import { config, isUpstreamAllowed, detectStreamKind } from "./config";
import type { Wrapped, WrapRequest, WrapResponse } from "./types";
import { fetchUpstream, getManifestRewriter, getContentType } from "./utils";

export const app: Application = express();
const wrapped = new Map<string, Wrapped>();

app.use(express.json());
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
app.get("/stream/:id.:ext", async (req, res) => {
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
    // Fetch from origin
    const upstreamRes = await fetchUpstream(
      stream.originUrl,
      req.headers as Record<string, string>
    );

    // For HLS/DASH manifests, we need to rewrite URLs
    if (stream.kind === "hls" || stream.kind === "dash") {
      if (!upstreamRes.ok) {
        return res.status(upstreamRes.status).json({ error: "Upstream error" });
      }

      const contentType = getContentType(stream.kind);
      const body = await upstreamRes.text();

      const rewriter = getManifestRewriter(stream.kind);
      const rewritten = rewriter.rewrite(body, id, config.baseUrl);

      res.setHeader("Content-Type", contentType);
      res.setHeader("Access-Control-Allow-Origin", "*");

      if (upstreamRes.headers.get("cache-control")) {
        res.setHeader(
          "Cache-Control",
          upstreamRes.headers.get("cache-control")!
        );
      }

      res.send(rewritten);
      console.log(
        `[MANIFEST] ${stream.kind} manifest proxied: ${id} (${body.length} -> ${rewritten.length} bytes)`
      );
      return;
    }

    // Progressive stream - pipe through
    {
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
app.get("/stream/:id/*", async (req, res) => {
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

    // Fetch segment from origin
    const upstreamRes = await fetchUpstream(
      segmentUrl,
      req.headers as Record<string, string>
    );

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
