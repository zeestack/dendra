/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // @modelcontextprotocol/sdk uses deep subpath imports — don't bundle it.
    serverComponentsExternalPackages: ["@modelcontextprotocol/sdk"],
  },
};

export default nextConfig;
