/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Native/deep-ESM packages — don't bundle, load at runtime.
    // (@modelcontextprotocol/sdk uses deep subpath imports.)
    serverComponentsExternalPackages: [
      "better-sqlite3",
      "@modelcontextprotocol/sdk",
    ],
    instrumentationHook: true, // enables instrumentation.ts (unhandled-rejection guard)
  },
};

export default nextConfig;
