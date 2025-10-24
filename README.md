# X402 Video Paylink

A streaming video paywall system using HTTP 402 Payment Required with dual payment schemes: JWT-based exact payment for manifests and EIP-712 voucher-based deferred payment for segments.

## Architecture

### Payment Flow

1. **Manifest Request** (`/stream/{id}.m3u8`)
   - Uses **exact scheme** with onchain payment verification
   - Returns JWT token for authenticated access
   - JWT scope covers all segments for the stream

2. **Segment Requests** (`/stream/{id}/segment.ts`)
   - Uses **deferred scheme** with EIP-712 signed vouchers
   - Vouchers are reused for 20 seconds to minimize signatures
   - After 20 seconds, client signs aggregated voucher with incremented nonce
   - No onchain settlement during playback

### Project Structure

```
x402-video-paylink/
├── apps/
│   ├── paylink-server/      # Express server with x402 middleware
│   └── cdk/                 # AWS CDK infrastructure
├── packages/
│   ├── paywall/             # React paywall UI with HLS.js
│   ├── deferred/            # EIP-712 voucher signing library
│   ├── payment-receipt/     # JWT receipt types
│   └── paylink-ui/          # Landing page
```

## Packages

### @x402-video-paylink/deferred

EIP-712 signature-based voucher system for deferred payments.

**Key Features:**
- Create and sign payment vouchers without onchain transactions
- Voucher aggregation with nonce increment
- Signature verification using viem

**Usage:**
```typescript
import { createVoucher, signVoucher } from '@x402-video-paylink/deferred';

const voucher = createVoucher({
  id: 'v-123',
  seller: '0x...',
  buyer: '0x...',
  asset: '0x...',
  nonce: 0,
  valueAggregate: '10000',
  timestamp: Math.floor(Date.now() / 1000),
  expiry: Math.floor(Date.now() / 1000) + 3600,
  chainId: 84532
});

const signature = await signVoucher(walletClient, voucher);
```

### @x402-video-paylink/paywall

React-based paywall UI with HLS.js video player.

**Features:**
- JWT authentication for manifests
- Voucher-based authentication for segments
- Automatic signature management with 20-second reuse window
- Video pause/resume during signature requests
- ArrayBuffer response decoding for binary segments

## Server Middleware

### JWT Exact Middleware

Handles manifest requests with exact payment scheme:
- Verifies onchain payment via x402 facilitator
- Issues JWT token with scope pattern
- Validates JWT on subsequent requests

### Deferred Payment Middleware

Handles segment requests with voucher aggregation:
- Verifies EIP-712 signatures offchain
- Allows voucher reuse within 20-second window
- Requests aggregation (nonce increment) after expiry
- Stores voucher state in-memory

## Development

### Prerequisites

- Node.js 20+
- pnpm
- Docker (for deployment)
- AWS CLI (for CDK deployment)

### Setup

```bash
# Install dependencies
pnpm install

# Build packages
pnpm -r build

# Run server locally
cd apps/paylink-server
pnpm dev
```

### Environment Variables

```env
# Server
JWT_SECRET=your-secret
MERCHANT_ADDRESS=0x...
STREAM_PRICE_USDC=0.01
X402_NETWORK=base-sepolia
BASE_URL=http://localhost:3000
ASSET_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
STEP_AMOUNT=10000
VOUCHER_TIME_WINDOW=20

# CDK (optional)
CDK_DEFAULT_ACCOUNT=123456789012
CDK_DEFAULT_REGION=ap-northeast-2
```

## Deployment

### AWS CDK

```bash
cd apps/cdk

# Deploy stack
pnpm run cdk deploy --profile <your-profile>

# View outputs
pnpm run cdk outputs --profile <your-profile>
```

**Deployed Resources:**
- ECS Fargate service (0.25 vCPU, 512 MB)
- Application Load Balancer
- CloudFront distribution (HTTPS)
- CloudWatch logs

## Configuration

### Voucher Time Window

Adjust the voucher reuse period by modifying:

1. **Server**: `apps/paylink-server/src/middleware/deferred-payment.ts:304`
   ```typescript
   if (timeDiff > 20) { // Change 20 to desired seconds
   ```

2. **CDK**: `apps/cdk/lib/cdk-stack.ts:51`
   ```typescript
   VOUCHER_TIME_WINDOW: process.env.VOUCHER_TIME_WINDOW || "20"
   ```

### Buffer Length

Control video buffer size in `packages/paywall/src/VideoPlayer.tsx:64`:
```typescript
maxBufferLength: 10, // seconds
```

## How It Works

### Initial Payment (Manifest)

1. User visits paywall page
2. User pays with wallet (onchain)
3. Server verifies payment and issues JWT
4. Client stores JWT and loads manifest

### Streaming (Segments)

1. Client creates initial voucher (nonce=0)
2. Client signs voucher with wallet
3. Client sends voucher with segment request
4. Server validates signature and allows access
5. Voucher is reused for 20 seconds
6. After 20 seconds, server returns 402 with aggregation request
7. Client increments nonce, updates timestamp, re-signs
8. Video pauses during signing and resumes after success

### Key Benefits

- **Reduced signatures**: Only 3 signatures per minute instead of 1 per segment
- **No onchain transactions**: Segments use offchain vouchers
- **Secure**: EIP-712 signatures prevent tampering
- **Efficient**: 20-second reuse window minimizes user friction

## License

MIT
