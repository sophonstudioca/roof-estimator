import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = {
  output: isGitHubPages ? "export" : undefined,
  basePath: isGitHubPages ? "/roof-estimator" : undefined,
  assetPrefix: isGitHubPages ? "/roof-estimator/" : undefined,
};

export default nextConfig;
