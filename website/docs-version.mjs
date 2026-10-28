// Which docs this build is: the current ones, or an archived major built by
// scripts/build-archived.mjs (which sets DOCS_ARCHIVED and DOCS_BASE_PATH).
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const [major, minor] = pkg.version.split('.')

export const SITE_ORIGIN = 'https://products.techfoundry.io'
export const LATEST_BASE_PATH = '/dendra'
export const basePath = process.env.DOCS_BASE_PATH || LATEST_BASE_PATH
export const archived = Boolean(process.env.DOCS_ARCHIVED)
/** The version these docs describe: "1.x" from 1.0, the minor ("0.12") before. */
export const label = major === '0' ? `${major}.${minor}` : `${major}.x`
/** Every docs version, newest first, with the base path it's served under. */
export const versions = [
  { label: archived ? 'Latest' : label, basePath: LATEST_BASE_PATH },
  ...JSON.parse(readFileSync(new URL('./versions.json', import.meta.url), 'utf8')).archived.map((v) => ({
    label: v.label,
    basePath: `${LATEST_BASE_PATH}/${v.path}`
  }))
]
