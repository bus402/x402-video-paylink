import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "./app";

describe("X402 Proxy Server", () => {
  describe("GET /health", () => {
    it("should return ok status", async () => {
      const response = await request(app).get("/health");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: "ok" });
    });
  });

  describe("POST /wrap", () => {
    it("should wrap HLS stream URL", async () => {
      const response = await request(app)
        .post("/wrap")
        .send({ url: "https://example.com/video.m3u8" });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("wrappedUrl");
      expect(response.body.wrappedUrl).toMatch(/\.m3u8$/);
      expect(response.body.wrappedUrl).toContain("/stream/");
    });

    it("should wrap DASH stream URL", async () => {
      const response = await request(app)
        .post("/wrap")
        .send({ url: "https://example.com/video.mpd" });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("wrappedUrl");
      expect(response.body.wrappedUrl).toMatch(/\.mpd$/);
    });

    it("should wrap progressive streams (MP4, MP3, WebM, etc.)", async () => {
      const extensions = ["mp4", "mp3", "webm", "ogg", "m4a", "aac"];

      const responses = await Promise.all(
        extensions.map((ext) =>
          request(app)
            .post("/wrap")
            .send({ url: `https://example.com/file.${ext}` })
        )
      );

      responses.forEach((response, index) => {
        expect(response.status).toBe(200);
        expect(response.body.wrappedUrl).toContain(`.${extensions[index]}`);
      });
    });

    it("should return 400 for missing or invalid url", async () => {
      const invalidCases = [
        {},
        { url: 123 },
        { url: "https://example.com/file.txt" },
      ];

      const responses = await Promise.all(
        invalidCases.map((body) => request(app).post("/wrap").send(body))
      );

      responses.forEach((response) => {
        expect(response.status).toBe(400);
        expect(response.body).toHaveProperty("error");
      });
    });

    it("should block private IPs and localhost (SSRF protection)", async () => {
      const blockedUrls = [
        "http://localhost/video.mp4",
        "http://127.0.0.1/video.mp4",
        "http://0.0.0.0/video.mp4",
        "http://10.0.0.1/video.mp4",
        "http://192.168.1.1/video.mp4",
        "http://172.16.0.1/video.mp4",
        "http://172.20.0.1/video.mp4",
        "http://172.31.255.254/video.mp4",
        "http://169.254.169.254/video.mp4", // AWS metadata
        "file:///etc/passwd",
      ];

      const responses = await Promise.all(
        blockedUrls.map((url) => request(app).post("/wrap").send({ url }))
      );

      responses.forEach((response, _) => {
        expect(response.status).toBe(403);
        expect(response.body.error).toContain("not allowed");
      });
    });

    it("should allow public IPs and valid domains", async () => {
      const allowedUrls = [
        "https://8.8.8.8/video.mp4",
        "https://example.com/video.mp4",
        "https://cdn.example.org/stream.m3u8",
        "https://video-service.io/content.mpd",
      ];

      const responses = await Promise.all(
        allowedUrls.map((url) => request(app).post("/wrap").send({ url }))
      );

      responses.forEach((response) => {
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("wrappedUrl");
      });
    });

    it("should create unique IDs for multiple wraps", async () => {
      const url = "https://example.com/video.mp4";

      const response1 = await request(app).post("/wrap").send({ url });
      const response2 = await request(app).post("/wrap").send({ url });

      expect(response1.body.wrappedUrl).not.toBe(response2.body.wrappedUrl);
    });
  });

  describe("GET /stream/:id.:ext", () => {
    it("should return 404 for non-existent stream", async () => {
      const response = await request(app).get("/stream/nonexistent.mp4");

      expect(response.status).toBe(404);
      expect(response.body.error).toContain("Stream not found");
    });

    it("should return 400 for extension mismatch", async () => {
      // Wrap different stream types
      const hlsWrap = await request(app)
        .post("/wrap")
        .send({ url: "https://example.com/video.m3u8" });
      const dashWrap = await request(app)
        .post("/wrap")
        .send({ url: "https://example.com/video.mpd" });
      const mp4Wrap = await request(app)
        .post("/wrap")
        .send({ url: "https://example.com/video.mp4" });

      const hlsId = hlsWrap.body.wrappedUrl.match(
        /\/stream\/(.+?)\.m3u8$/
      )?.[1];
      const dashId = dashWrap.body.wrappedUrl.match(
        /\/stream\/(.+?)\.mpd$/
      )?.[1];
      const mp4Id = mp4Wrap.body.wrappedUrl.match(/\/stream\/(.+?)\.mp4$/)?.[1];

      // Try to access with wrong extensions
      const wrongExts = [
        request(app).get(`/stream/${hlsId}.mpd`),
        request(app).get(`/stream/${dashId}.m3u8`),
        request(app).get(`/stream/${mp4Id}.mp3`),
      ];

      const responses = await Promise.all(wrongExts);

      responses.forEach((response) => {
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("Extension mismatch");
      });
    });
  });

  describe("GET /stream/:id.:ext (proxying)", () => {
    it("should proxy HLS manifest and rewrite URLs", async () => {
      const hlsUrl =
        "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8";

      // Wrap the HLS stream
      const wrapResponse = await request(app)
        .post("/wrap")
        .send({ url: hlsUrl });
      expect(wrapResponse.status).toBe(200);

      const wrappedUrl = wrapResponse.body.wrappedUrl;
      const streamPath = wrappedUrl.match(/\/stream\/.+$/)?.[0] || "";

      // Fetch the proxied manifest
      const streamResponse = await request(app).get(streamPath);

      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers["content-type"]).toContain(
        "application/vnd.apple.mpegurl"
      );
      expect(streamResponse.headers["access-control-allow-origin"]).toBe("*");
      expect(streamResponse.text).toContain("#EXTM3U");
      // Check that URLs have been rewritten to go through our proxy
      expect(streamResponse.text).toMatch(/\/stream\/\w+\//);
    }, 10000);

    it("should proxy progressive MP4 stream with correct headers", async () => {
      const mp4Url =
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

      // Wrap the MP4
      const wrapResponse = await request(app)
        .post("/wrap")
        .send({ url: mp4Url });
      expect(wrapResponse.status).toBe(200);

      const wrappedUrl = wrapResponse.body.wrappedUrl;
      const streamPath = wrappedUrl.match(/\/stream\/.+$/)?.[0] || "";

      // Fetch with range to avoid downloading entire file
      const response = await request(app)
        .get(streamPath)
        .set("Range", "bytes=0-0");

      expect(response.status).toBe(206);
      expect(response.headers["content-type"]).toBe("video/mp4");
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["content-range"]).toBeDefined();
      expect(response.headers["accept-ranges"]).toBe("bytes");
    }, 15000);

    it("should support range requests for progressive streams", async () => {
      const mp4Url =
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

      // Wrap the MP4
      const wrapResponse = await request(app)
        .post("/wrap")
        .send({ url: mp4Url });
      const wrappedUrl = wrapResponse.body.wrappedUrl;
      const streamPath = wrappedUrl.match(/\/stream\/.+$/)?.[0] || "";

      // Request with range header
      const rangeResponse = await request(app)
        .get(streamPath)
        .set("Range", "bytes=0-1023");

      expect(rangeResponse.status).toBe(206);
      expect(rangeResponse.headers["content-range"]).toBeDefined();
      expect(rangeResponse.headers["content-length"]).toBe("1024");
      expect(rangeResponse.body.length).toBe(1024);
    }, 10000);
  });

  describe("GET /stream/:id/*", () => {
    it("should proxy HLS segments", async () => {
      const hlsUrl =
        "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8";

      // Wrap the HLS stream
      const wrapResponse = await request(app)
        .post("/wrap")
        .send({ url: hlsUrl });
      const wrappedUrl = wrapResponse.body.wrappedUrl;
      const streamPath = wrappedUrl.match(/\/stream\/.+$/)?.[0] || "";

      // Get manifest to find segment URL
      const manifestResponse = await request(app).get(streamPath);
      const manifest = manifestResponse.text;

      // Extract first segment URL from manifest
      const lines = manifest.split("\n");
      const segmentLine = lines.find(
        (line) =>
          line.startsWith("http://localhost:3000/stream/") &&
          line.includes(".m3u8")
      );

      if (segmentLine) {
        const segmentPath = segmentLine.match(/\/stream\/.+$/)?.[0] || "";
        const segmentResponse = await request(app).get(segmentPath);

        expect(segmentResponse.status).toBe(200);
        expect(segmentResponse.headers["access-control-allow-origin"]).toBe(
          "*"
        );
      }
    }, 15000);
  });
});
