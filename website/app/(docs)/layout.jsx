import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { getPageMap } from 'nextra/page-map'

function Logo() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden>
        <defs>
          <linearGradient id="nav-lg" x1="0" y1="0" x2="32" y2="32">
            <stop stopColor="#7c9cff" />
            <stop offset="1" stopColor="#5be3b3" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="6" r="3.2" fill="url(#nav-lg)" />
        <circle cx="6" cy="24" r="3.2" fill="url(#nav-lg)" />
        <circle cx="26" cy="24" r="3.2" fill="url(#nav-lg)" />
        <path d="M16 9v7m0 0l-9 6m9-6l9 6" stroke="url(#nav-lg)" strokeWidth="2.1" />
      </svg>
      <b
        style={{
          background: 'linear-gradient(120deg,#7c9cff,#5be3b3)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
          letterSpacing: '-0.02em'
        }}
      >
        dendra
      </b>
    </span>
  )
}

export default async function DocsLayout({ children }) {
  return (
    <Layout
      navbar={<Navbar logo={<Logo />} projectLink="https://github.com/zeestack/dendra" />}
      footer={<Footer>MIT © dendra</Footer>}
      pageMap={await getPageMap()}
      docsRepositoryBase="https://github.com/zeestack/dendra/tree/main/website"
    >
      {children}
    </Layout>
  )
}
