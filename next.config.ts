import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH || undefined
};

export default nextConfig;
