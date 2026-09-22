import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Safari has repeatedly kept serving an old chunk after the file changed —
  // the URL of a dev chunk does not change with its contents, and Safari's
  // disk cache does not always revalidate a `no-cache` response. `no-store`
  // keeps every dev chunk out of the disk cache altogether. Production
  // chunks carry a content hash in their URL and are left alone.
  async headers() {
    if (process.env.NODE_ENV === "production") return [];
    return [{ source: "/_next/static/:path*", headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }] }];
  },
  turbopack: {
    resolveAlias: {
      canvas: "./empty-module.ts",
    },
  },
};

export default nextConfig;
