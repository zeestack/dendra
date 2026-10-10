/** @type {import('next').NextConfig} */
const nextConfig = {
  // nexus-rpc is aliased to its TypeScript source (see tsconfig paths) so the
  // editor tracks it live. externalDir lets Next compile that source from outside
  // the app directory; transpilePackages stays as a fallback for the node_modules
  // resolution path used by the standalone scripts.
  experimental: { externalDir: true },
  transpilePackages: ["nexus-rpc"],
};

export default nextConfig;
