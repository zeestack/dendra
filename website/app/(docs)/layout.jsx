import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Banner } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import { VersionSwitcher } from '../../components/version-switcher'

function Logo() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <svg width="24" height="24" viewBox="0 0 100 100" fill="none" aria-hidden>
        <defs>
          <linearGradient id="nav-lg" x1="0" y1="0" x2="100" y2="100">
            <stop stopColor="#7c9cff" />
            <stop offset="1" stopColor="#5be3b3" />
          </linearGradient>
        </defs>
        <g
          transform="translate(6,50)"
          stroke="url(#nav-lg)"
          strokeWidth="4"
          fill="none"
          strokeLinecap="round"
        >
          <path d="M0,0 C22,0 22,-30 44,-30" />
          <path d="M0,0 C22,0 22,30 44,30" />
          <path d="M44,-30 C66,-30 66,-50 88,-50" />
          <path d="M44,-30 C66,-30 66,-10 88,-10" />
          <path d="M44,30 C66,30 66,10 88,10" />
          <path d="M44,30 C66,30 66,50 88,50" />
        </g>
        <g transform="translate(6,50)">
          <circle cx="0" cy="0" r="9" fill="#5be3b3" />
          <circle cx="44" cy="-30" r="5" fill="#7fd6c4" />
          <circle cx="44" cy="30" r="5" fill="#7fd6c4" />
          <circle cx="88" cy="-50" r="6" fill="#7c9cff" />
          <circle cx="88" cy="-10" r="6" fill="#7c9cff" />
          <circle cx="88" cy="10" r="6" fill="#7c9cff" />
          <circle cx="88" cy="50" r="6" fill="#7c9cff" />
        </g>
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
      navbar={
        <Navbar logo={<Logo />} projectLink="https://github.com/zeestack/dendra">
          <VersionSwitcher />
        </Navbar>
      }
      banner={
        process.env.DOCS_ARCHIVED ? (
          <Banner dismissible={false}>
            These are the docs for dendra {process.env.DOCS_LABEL}.{' '}
            <a href="/dendra/" style={{ textDecoration: 'underline' }}>
              Read the latest docs
            </a>
          </Banner>
        ) : undefined
      }
      footer={<Footer>MIT © dendra</Footer>}
      pageMap={await getPageMap()}
      docsRepositoryBase="https://github.com/zeestack/dendra/tree/main/website"
    >
      {children}
    </Layout>
  )
}
