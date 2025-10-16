FROM --platform=linux/amd64 node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 py3-setuptools make g++

# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/paylink-server ./apps/paylink-server
COPY packages/paywall ./packages/paywall
COPY packages/payment-receipt ./packages/payment-receipt
COPY packages/paylink-ui ./packages/paylink-ui

# Install pnpm
RUN npm install -g pnpm

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build packages
RUN cd packages/payment-receipt && pnpm build
RUN cd packages/paywall && pnpm build:paywall
RUN cd apps/paylink-server && pnpm build

# Production stage
FROM --platform=linux/amd64 node:20-alpine

WORKDIR /app

# Install build dependencies for native modules
RUN apk add --no-cache python3 py3-setuptools make g++

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/paylink-server/package.json ./apps/paylink-server/
COPY packages/paywall/package.json ./packages/paywall/
COPY packages/payment-receipt/package.json ./packages/payment-receipt/
COPY packages/paylink-ui/package.json ./packages/paylink-ui/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built files
COPY --from=builder /app/apps/paylink-server/dist ./apps/paylink-server/dist
COPY --from=builder /app/packages/payment-receipt/dist ./packages/payment-receipt/dist
COPY --from=builder /app/packages/paywall/gen ./packages/paywall/gen
COPY --from=builder /app/packages/paylink-ui/index.html ./packages/paylink-ui/index.html

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "apps/paylink-server/dist/server.js"]
