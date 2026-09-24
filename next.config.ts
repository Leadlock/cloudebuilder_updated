import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfkit reads its bundled AFM font files from node_modules at runtime;
  // bundling it breaks those paths, so load it with native require.
  serverExternalPackages: ['pdfkit'],
};

export default nextConfig;
