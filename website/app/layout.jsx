import { Head } from 'nextra/components'
import 'nextra-theme-docs/style.css'
// "dendra" alone is a crowded search term (an archaeological site, a Pokémon,
// a sensor-data service), so every title carries what dendra *is*.
export const metadata = {
  metadataBase: new URL('https://products.techfoundry.io'),
  title: {
    default: 'dendra — typed RPC & MCP framework for TypeScript',
    template: '%s – dendra, typed RPC & MCP for TypeScript'
  },
  description:
    'dendra is a typed RPC/REST framework for Next.js and TypeScript where every procedure is also an LLM tool and an MCP server. No codegen, no decorators, zero dependencies.',
  applicationName: 'dendra',
  keywords: ['dendra', 'typed RPC', 'TypeScript RPC', 'MCP server', 'Model Context Protocol', 'LLM tools', 'Next.js API', 'tRPC alternative', 'OpenAPI'],
  openGraph: { siteName: 'dendra', type: 'website', locale: 'en_US' },
  twitter: { card: 'summary' }
}
export default function RootLayout({ children }) {
  return <html lang="en" dir="ltr" suppressHydrationWarning><Head /><body>{children}</body></html>
}
