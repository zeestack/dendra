import nextra from 'nextra'
const withNextra = nextra({})
export default withNextra({
  output: 'export',
  images: { unoptimized: true },
  basePath: '/dendra',
  trailingSlash: true,
  outputFileTracingRoot: import.meta.dirname
})
