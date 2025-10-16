export async function fetchUpstream(
  url: string,
  headers: Record<string, string> = {}
) {
  return await fetch(url, {
    headers: {
      "User-Agent": headers["user-agent"] || "x402-proxy/1.0",
      ...(headers["accept"] && { Accept: headers["accept"] }),
      ...(headers["accept-encoding"] && {
        "Accept-Encoding": headers["accept-encoding"],
      }),
      ...(headers["if-modified-since"] && {
        "If-Modified-Since": headers["if-modified-since"],
      }),
      ...(headers["if-none-match"] && {
        "If-None-Match": headers["if-none-match"],
      }),
      ...(headers["range"] && { Range: headers["range"] }),
      ...(headers["if-range"] && { "If-Range": headers["if-range"] }),
    },
  });
}

// Common interface for manifest rewriters
export interface ManifestRewriter {
  rewrite(content: string, streamId: string, baseUrl: string): string;
}

// HLS Manifest Rewriter
export class HlsRewriter implements ManifestRewriter {
  rewrite(content: string, streamId: string, baseUrl: string): string {
    const lines = content.split("\n");
    const rewritten: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (trimmed.startsWith("#") || trimmed === "") {
        rewritten.push(line);
        continue;
      }

      // This is a URI line (segment, key, playlist, etc.)
      // Check if it's already absolute
      if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        // Absolute URL - rewrite to go through our proxy
        const encoded = encodeURIComponent(trimmed);
        rewritten.push(`${baseUrl}/stream/${streamId}/${encoded}`);
      } else {
        // Relative URL - prefix with our proxy path
        rewritten.push(`${baseUrl}/stream/${streamId}/${trimmed}`);
      }
    }

    return rewritten.join("\n");
  }
}

// DASH Manifest Rewriter
export class DashRewriter implements ManifestRewriter {
  rewrite(content: string, streamId: string, baseUrl: string): string {
    return (
      content
        // Rewrite <BaseURL>...</BaseURL>
        .replace(/<BaseURL>(.*?)<\/BaseURL>/g, (_match, url) => {
          const rewrittenUrl = this.rewriteUrl(url, streamId, baseUrl);
          return `<BaseURL>${rewrittenUrl}</BaseURL>`;
        })
        // Rewrite media/initialization attributes
        .replace(/(media|initialization)="([^"]+)"/g, (_match, attr, url) => {
          const rewrittenUrl = this.rewriteUrl(url, streamId, baseUrl);
          return `${attr}="${rewrittenUrl}"`;
        })
    );
  }

  private rewriteUrl(url: string, streamId: string, baseUrl: string): string {
    if (!url || url.trim() === "") return url;

    const trimmed = url.trim();

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      // Absolute URL - encode and proxy
      const encoded = encodeURIComponent(trimmed);
      return `${baseUrl}/stream/${streamId}/${encoded}`;
    } else {
      // Relative URL - prefix with proxy path
      return `${baseUrl}/stream/${streamId}/${trimmed}`;
    }
  }
}

// Factory for creating rewriters
export function getManifestRewriter(kind: "hls" | "dash"): ManifestRewriter {
  switch (kind) {
    case "hls":
      return new HlsRewriter();
    case "dash":
      return new DashRewriter();
  }
}

export function getContentType(kind: string, originalExt?: string): string {
  if (kind === "hls") {
    return "application/vnd.apple.mpegurl";
  } else if (kind === "dash") {
    return "application/dash+xml";
  } else if (kind === "progressive") {
    const ext = originalExt?.toLowerCase();
    switch (ext) {
      case "mp4":
        return "video/mp4";
      case "mp3":
        return "audio/mpeg";
      case "webm":
        return "video/webm";
      case "ogg":
        return "audio/ogg";
      case "m4a":
        return "audio/mp4";
      case "aac":
        return "audio/aac";
      default:
        return "application/octet-stream";
    }
  }
  return "application/octet-stream";
}
