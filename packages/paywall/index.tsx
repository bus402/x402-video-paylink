import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Providers } from "./src/Providers";
import { PaywallApp } from "./src/PaywallApp";
import { VideoPlayer } from "./src/VideoPlayer";
import "./src/utils/window.d.ts";

function App() {
  const [status, setStatus] = useState<"loading" | "paywall" | "playing">(
    "loading"
  );
  const [jwt, setJwt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Extract stream ID from currentUrl
    const streamId =
      window.x402?.currentUrl?.match(/\/stream\/([^\/\.]+)/)?.[1];

    if (streamId) {
      // Check if JWT exists for this specific stream
      const jwtKey = `x402-jwt-${streamId}`;
      const existingJwt = localStorage.getItem(jwtKey);
      if (existingJwt) {
        console.log(`[Paywall] Found JWT for stream ${streamId}`);
        setJwt(existingJwt);
        setStatus("playing");
        return;
      }
    }

    // No JWT found, show paywall
    if (window.x402) {
      setStatus("paywall");
    } else {
      setError("Payment configuration not found");
    }
  }, []);

  const handlePaymentSuccess = (receivedJwt: string) => {
    console.log(`[Paywall] Payment success, transitioning to playing`);
    setJwt(receivedJwt);
    setStatus("playing");
  };

  if (error) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <h1>Error</h1>
        <p style={{ color: "red" }}>{error}</p>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div style={{ padding: "2rem", textAlign: "center" }}>
        <h1>Loading...</h1>
      </div>
    );
  }

  if (status === "paywall" && window.x402) {
    return (
      <Providers>
        <PaywallApp onPaymentSuccess={handlePaymentSuccess} />
      </Providers>
    );
  }

  if (status === "playing" && jwt && window.x402?.currentUrl) {
    return <VideoPlayer streamUrl={window.x402.currentUrl} jwt={jwt} />;
  }

  return null;
}

window.addEventListener("load", () => {
  const root = document.getElementById("root");
  if (root) {
    createRoot(root).render(<App />);
  }
});
