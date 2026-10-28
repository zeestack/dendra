// Served at /dendra/sitemap.xml — submit that URL in Google Search Console.
// Static export needs the route forced static.
export const dynamic = 'force-static'

const SITE = 'https://products.techfoundry.io/dendra'
const PAGES = ['', 'quickstart', 'ai-mcp', 'context', 'features', 'architecture', 'compare', 'releases', 'upgrading', 'versioning', 'reference',
  'reference/router', 'reference/schema', 'reference/server', 'reference/client', 'reference/realtime',
  'reference/jobs', 'reference/ai', 'reference/agents', 'reference/adapter']

export default function sitemap() {
  return PAGES.map((p) => ({
    url: p ? `${SITE}/${p}/` : `${SITE}/`,
    changeFrequency: 'weekly',
    priority: p ? 0.7 : 1
  }))
}
