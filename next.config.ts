import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH || undefined
};

export default nextConfig;
