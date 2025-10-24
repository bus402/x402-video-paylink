"use client";

import React, { useEffect, useRef } from "react";
import Hls from "hls.js";
import {
  type DeferredVoucher,
  type VoucherState,
  createVoucher,
  signVoucher,
  encodePayment,
} from "@x402-video-paylink/deferred";
import { useWalletClient } from "wagmi";
import { publicActions } from "viem";

interface VideoPlayerProps {
  streamUrl: string;
  jwt: string;
}

// Check if URL is a manifest (e.g., /stream/abc.m3u8) or segment (e.g., /stream/abc/segment0.ts)
function isManifestUrl(url: string): boolean {
  // Handle both absolute and relative URLs
  let pathname: string;
  try {
    const urlObj = new URL(url);
    pathname = urlObj.pathname;
  } catch {
    // If URL parsing fails, assume it's a relative URL
    pathname = url.split("?")[0]; // Remove query params
  }

  const pathParts = pathname.split("/").filter(Boolean);

  // Manifest pattern: /stream/{id}.{ext} (2 parts after removing empty)
  // Segment pattern: /stream/{id}/{...} (3+ parts)
  return pathParts.length === 2;
}

export function VideoPlayer({ streamUrl, jwt }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const voucherStateRef = useRef<VoucherState | null>(null);
  const signingInProgressRef = useRef<boolean>(false);
  const { data: wagmiWalletClient } = useWalletClient();

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
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        // Limit buffer to ~10-15 seconds to enforce frequent re-authentication
        maxBufferLength: 10, // seconds
        maxBufferSize: 10 * 1024 * 1024, // 10 MB
        maxMaxBufferLength: 15, // max 15 seconds

        xhrSetup: (xhr, url) => {
          // Check if this is a manifest or segment request
          const isManifest = isManifestUrl(url);

          if (isManifest) {
            // Manifest requests use JWT Bearer
            xhr.setRequestHeader("Authorization", `Bearer ${actualJwt}`);
          } else {
            // Segment/variant requests use deferred voucher
            // IMPORTANT: Only use existing voucher, no async signing here!
            // xhrSetup must be synchronous - async operations break XMLHttpRequest state
            if (voucherStateRef.current) {
              const paymentHeader = encodePayment(
                voucherStateRef.current.voucher,
                voucherStateRef.current.signature
              );
              xhr.setRequestHeader("X-PAYMENT", paymentHeader);
            }
          }
        },
      });

      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((err) => {
          console.error("[VideoPlayer] Autoplay failed:", err);
        });
      });

      hls.on(Hls.Events.ERROR, async (event, data) => {
        // Handle 402 payment required for segments or variant manifests
        if (
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          data.response?.code === 402
        ) {
          // If already signing, ignore this error (will retry after signing completes)
          if (signingInProgressRef.current) {
            return;
          }

          if (!wagmiWalletClient) {
            console.error(`[VideoPlayer] No wallet client available`);
            return;
          }

          // Set signing flag
          signingInProgressRef.current = true;

          const walletClient = wagmiWalletClient.extend(publicActions);

          try {
            // Parse 402 response to get payment requirements
            let paymentRequirements: any = null;

            const xhr = data.networkDetails as any;
            if (xhr?.response) {
              if (typeof xhr.response === 'string') {
                paymentRequirements = JSON.parse(xhr.response);
              } else if (xhr.response instanceof ArrayBuffer) {
                const text = new TextDecoder().decode(xhr.response);
                paymentRequirements = JSON.parse(text);
              } else {
                paymentRequirements = xhr.response;
              }
            } else if (xhr?.responseText) {
              paymentRequirements = JSON.parse(xhr.responseText);
            }

            if (!paymentRequirements?.accepts?.[0]) {
              console.error(`[VideoPlayer] Invalid 402 response`);
              return;
            }

            const requirement = paymentRequirements.accepts[0];
            const extra = requirement.extra;

            // Handle aggregation request (server asking for nonce increment)
            if (extra?.type === "aggregation" && extra.voucher) {
              // Remember playback state before pausing
              const wasPlaying = !video.paused;
              const currentTime = video.currentTime;

              // Stop loading while signing
              hls.stopLoad();

              const now = Math.floor(Date.now() / 1000);
              const account = walletClient.account;
              if (!account) {
                console.error(`[VideoPlayer] No account in wallet`);
                signingInProgressRef.current = false;
                return;
              }

              // Create new voucher with incremented nonce and updated timestamp
              const newVoucher: DeferredVoucher = createVoucher({
                id: extra.voucher.id,
                seller: extra.voucher.seller,
                buyer: extra.voucher.buyer,
                asset: extra.voucher.asset,
                nonce: extra.voucher.nonce + 1,
                valueAggregate: (BigInt(extra.voucher.valueAggregate) + BigInt(10000)).toString(),
                timestamp: now,
                expiry: extra.voucher.expiry,
                chainId: extra.voucher.chainId,
              });

              const signature = await signVoucher(walletClient, newVoucher);

              voucherStateRef.current = {
                voucher: newVoucher,
                signature,
              };

              signingInProgressRef.current = false;

              // Retry with new voucher
              hls.startLoad();

              // Resume playback immediately if it was playing
              if (wasPlaying) {
                // Small delay to ensure buffer starts loading
                setTimeout(() => {
                  video.play().catch(err => console.error(`[VideoPlayer] Failed to resume:`, err));
                }, 100);
              }

              return;
            }

            if (extra?.type !== "new" || !extra.voucher?.id) {
              console.error(`[VideoPlayer] Invalid payment requirement`);
              signingInProgressRef.current = false;
              return;
            }

            // Create initial voucher
            const now = Math.floor(Date.now() / 1000);
            const account = walletClient.account;
            if (!account) {
              console.error(`[VideoPlayer] No account in wallet`);
              signingInProgressRef.current = false;
              return;
            }

            const voucher: DeferredVoucher = createVoucher({
              id: extra.voucher.id,
              seller: requirement.payTo,
              buyer: account.address,
              asset: requirement.asset,
              nonce: 0,
              valueAggregate: requirement.maxAmountRequired,
              timestamp: now,
              expiry: now + 3600, // 1 hour
              chainId: requirement.network === "base-sepolia" ? 84532 : 8453,
            });

            // Sign voucher
            const signature = await signVoucher(walletClient, voucher);

            // Store voucher state
            voucherStateRef.current = {
              voucher,
              signature,
            };

            // Clear signing flag BEFORE retrying
            signingInProgressRef.current = false;

            // Retry all pending requests with the new voucher
            hls.startLoad();
          } catch (err) {
            console.error(`[VideoPlayer] Failed to create voucher:`, err);
            signingInProgressRef.current = false;

            // If user cancelled signing, retry after a short delay
            // This will trigger another 402 and prompt for signature again
            setTimeout(() => {
              hls.startLoad();
            }, 1000);
          }
        } else if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
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
      video.src = streamUrl;
      video.addEventListener("loadedmetadata", () => {
        video.play().catch((err) => {
          console.error("[VideoPlayer] Autoplay failed:", err);
        });
      });
    } else {
      console.error("[VideoPlayer] HLS not supported");
    }
  }, [streamUrl, jwt, wagmiWalletClient]);

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#000",
      }}
    >
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
