import { Head } from 'nextra/components'
import 'nextra-theme-docs/style.css'
export const metadata = {
  title: { default: 'dendra', template: '%s – dendra' },
  description: 'Typed RPC/REST for Next.js where every procedure is also an LLM tool and an MCP server.'
}
export default function RootLayout({ children }) {
  return <html lang="en" dir="ltr" suppressHydrationWarning><Head /><body>{children}</body></html>
}
