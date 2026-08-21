import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@teammate/local-client"],
  // The dev badge overlaps persistent workspace actions (for example Settings save).
  devIndicators: false,
};

export default nextConfig;
