import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { getPageMap } from 'nextra/page-map'
export default async function DocsLayout({ children }) {
  return (
    <Layout
      navbar={<Navbar logo={<b>dendra</b>} projectLink="https://github.com/zeestack/dendra" />}
      footer={<Footer>MIT © dendra</Footer>}
      pageMap={await getPageMap()}
      docsRepositoryBase="https://github.com/zeestack/dendra/tree/main/website"
    >
      {children}
    </Layout>
  )
}
