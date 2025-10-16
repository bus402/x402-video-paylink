/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@coinbase/onchainkit'],
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    config.externals.push('pino-pretty', 'encoding');
    return config;
  },
};

export default nextConfig;
