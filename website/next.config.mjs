import nextra from 'nextra'
import { basePath, label, archived, versions } from './docs-version.mjs'

const withNextra = nextra({})
export default withNextra({
  output: 'export',
  images: { unoptimized: true },
  basePath,
  trailingSlash: true,
  outputFileTracingRoot: import.meta.dirname,
  // Read by the layout for the version switcher and the archived-docs banner.
  env: {
    DOCS_BASE_PATH: basePath,
    DOCS_LABEL: label,
    DOCS_ARCHIVED: archived ? '1' : '',
    DOCS_VERSIONS: JSON.stringify(versions)
  }
})
