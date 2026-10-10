/** @type {import('next').NextConfig} */
const nextConfig = {
  // dendra is aliased to its TypeScript source (see tsconfig paths) so the
  // editor tracks it live. externalDir lets Next compile that source from outside
  // the app directory; transpilePackages stays as a fallback for the node_modules
  // resolution path used by the standalone scripts.
  experimental: {
    externalDir: true,
    // Native/deep-ESM packages — don't bundle, load at runtime.
    // (@modelcontextprotocol/sdk uses deep subpath imports.)
    serverComponentsExternalPackages: [
      "better-sqlite3",
      "@modelcontextprotocol/sdk",
    ],
  },
  transpilePackages: ["dendra"],
};

export default nextConfig;
