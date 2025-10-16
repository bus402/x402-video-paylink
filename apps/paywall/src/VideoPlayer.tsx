"use client";

import React, { useEffect, useRef } from "react";
import Hls from "hls.js";

interface VideoPlayerProps {
  streamUrl: string;
  jwt: string;
}

export function VideoPlayer({ streamUrl, jwt }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Extract stream ID and try to get JWT from localStorage first
    const streamId = streamUrl.match(/\/stream\/([^\/\.]+)/)?.[1];
    const jwtKey = streamId ? `x402-jwt-${streamId}` : null;
    const storedJwt = jwtKey ? localStorage.getItem(jwtKey) : null;

    // Use stored JWT if available, otherwise use prop
    const actualJwt = storedJwt || jwt;

    if (!actualJwt) {
      console.log(`[VideoPlayer] No JWT available yet`);
      return;
    }

    console.log(`[VideoPlayer] Initializing HLS with JWT:`, actualJwt.substring(0, 20) + "...");
    console.log(`[VideoPlayer] JWT source:`, storedJwt ? "localStorage" : "props");

    const proxyUrl = `http://localhost:3000${streamUrl}`;

    if (Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: (xhr, url) => {
          // Add JWT to all requests (manifest + segments)
          console.log(`[VideoPlayer] Setting Authorization header for ${url}`);
          xhr.setRequestHeader("Authorization", `Bearer ${actualJwt}`);
        },
      });

      hls.loadSource(proxyUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log("[VideoPlayer] Manifest loaded, starting playback");
        video.play().catch(err => {
          console.error("[VideoPlayer] Autoplay failed:", err);
        });
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error("[VideoPlayer] HLS error:", data);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log("[VideoPlayer] Network error, trying to recover");
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log("[VideoPlayer] Media error, trying to recover");
              hls.recoverMediaError();
              break;
            default:
              console.error("[VideoPlayer] Fatal error, cannot recover");
              hls.destroy();
              break;
          }
        }
      });

      hlsRef.current = hls;

      return () => {
        hls.destroy();
      };
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS support (Safari)
      video.src = proxyUrl;
      video.addEventListener("loadedmetadata", () => {
        video.play().catch(err => {
          console.error("[VideoPlayer] Autoplay failed:", err);
        });
      });
    } else {
      console.error("[VideoPlayer] HLS not supported");
    }
  }, [streamUrl, jwt]);

  return (
    <div style={{
      width: "100%",
      height: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#000",
    }}>
      <video
        ref={videoRef}
        controls
        style={{
          width: "100%",
          maxWidth: "100%",
          height: "auto",
        }}
      />
    </div>
  );
}
