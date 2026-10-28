import { generateStaticParamsFor, importPage } from 'nextra/pages'
import { useMDXComponents as getMDXComponents } from '../../../mdx-components'

export const generateStaticParams = generateStaticParamsFor('mdxPath')

export async function generateMetadata(props) {
  const params = await props.params
  const { metadata } = await importPage(params.mdxPath)
  // Absolute canonical + social preview per page (metadata URLs don't get the
  // basePath added automatically). Archived versions stay out of search results.
  const url = `https://products.techfoundry.io${process.env.DOCS_BASE_PATH}/${(params.mdxPath ?? []).join('/')}/`
  return {
    ...metadata,
    ...(process.env.DOCS_ARCHIVED ? { robots: { index: false } } : {}),
    alternates: { canonical: url },
    openGraph: { title: metadata.title, description: metadata.description, url }
  }
}

const Wrapper = getMDXComponents().wrapper

export default async function Page(props) {
  const params = await props.params
  const { default: MDXContent, toc, metadata, sourceCode } = await importPage(params.mdxPath)
  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  )
}
