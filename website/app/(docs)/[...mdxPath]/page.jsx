import { generateStaticParamsFor, importPage } from 'nextra/pages'
import { useMDXComponents as getMDXComponents } from '../../../mdx-components'

export const generateStaticParams = generateStaticParamsFor('mdxPath')

export async function generateMetadata(props) {
  const params = await props.params
  const { metadata } = await importPage(params.mdxPath)
  // Absolute canonical + social preview per page (metadata URLs don't get the
  // basePath added automatically).
  const url = `https://products.techfoundry.io/dendra/${(params.mdxPath ?? []).join('/')}/`
  return {
    ...metadata,
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
