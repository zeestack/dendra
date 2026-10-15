import Link from 'next/link'
import hljs from 'highlight.js/lib/core'
import ts from 'highlight.js/lib/languages/typescript'
import styles from './home.module.css'

hljs.registerLanguage('typescript', ts)

export const metadata = {
  title: 'dendra — typed RPC & MCP for Next.js',
  description:
    'Define a procedure once. Get a typed client, REST + OpenAPI, streaming, an LLM tool, and an MCP server — zero-dependency core, no codegen, no decorators.'
}

/* The real dendra mark: a branching dendrite — one node → two → four.
   "one definition, many surfaces." */
function Mark({ size = 26, id = 'm' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={`lg-${id}`} x1="0" y1="0" x2="100" y2="100">
          <stop stopColor="#7c9cff" />
          <stop offset="1" stopColor="#5be3b3" />
        </linearGradient>
      </defs>
      <g
        transform="translate(6,50)"
        stroke={`url(#lg-${id})`}
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
  )
}

const FEATURES = [
  {
    t: 'One definition, many surfaces',
    b: 'A typed client, REST + OpenAPI 3.1, streaming, an in-process caller, an LLM tool, and an MCP server — all projected from a single procedure. They can’t drift.'
  },
  {
    t: 'No codegen, no decorators',
    b: 'The client type comes from typeof appRouter — pure inference. Nothing to generate, nothing to run, nothing to keep in sync.'
  },
  {
    t: 'AI is a byproduct',
    b: 'Mark a procedure .ai() and it becomes a tool the model can call — with the same input validation and the same request context as your HTTP calls.'
  },
  {
    t: 'MCP, both directions',
    b: 'Expose your procedures as an MCP server, and consume external MCP servers — merged into one toolset your agent (or Claude) can use.'
  },
  {
    t: 'Zero-dependency core',
    b: 'The core ships with no runtime dependencies. runAgent, useAssistant, and persistent memory are opt-in subpaths you add only when you want them.'
  },
  {
    t: 'Context, managed',
    b: 'Persistent recall and lazy tool loading (search_tools) keep a model’s window lean even when you connect big MCP connectors.'
  }
]

const CODE = `// server/router.ts — define once
import { initDendra, s, type RouterRecord } from 'dendra'
const { route } = initDendra<Ctx>()

export const appRouter = {
  notes: {
    list: route.get('/notes')
      .handler(({ ctx }) => ctx.db.notes.all()),

    create: route.post('/notes')
      .input(s.object({ title: s.string(), body: s.string() }))
      .ai({ description: 'Create a note' })   // ← also an LLM / MCP tool
      .handler(({ input, ctx }) => ctx.db.notes.insert(input)),
  },
} satisfies RouterRecord
export type AppRouter = typeof appRouter

// lib/api.ts — typed client, inferred, no codegen
const api = createClient<AppRouter>('', { prefix: '/rpc/' })
await api.notes.create({ title, body })   // fully typed`

export default function Home() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          <Mark id="hdr" />
          <span className={styles.word}>dendra</span>
        </Link>
        <div className={styles.spacer} />
        <Link className={styles.headerLink} href="/quickstart">
          Docs
        </Link>
        <a
          className={styles.headerLink}
          href="https://www.npmjs.com/package/dendra"
          target="_blank"
          rel="noreferrer"
        >
          npm
        </a>
        <a
          className={styles.headerLink}
          href="https://github.com/zeestack/dendra"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroMark}>
          <Mark size={76} id="hero" />
        </div>
        <div className={styles.pills}>
          <span className={styles.pill}>Next.js & Web-standard runtimes</span>
          <span className={styles.pill}>Zero-dependency core</span>
          <span className={styles.pill}>MCP both directions</span>
        </div>
        <h1 className={styles.h1}>
          One procedure.
          <br />
          <span className={styles.grad}>Every surface.</span>
        </h1>
        <p className={styles.sub}>
          Typed RPC/REST for Next.js where every procedure is also an LLM tool
          and an MCP server. Define it once — get a typed client, REST, OpenAPI,
          streaming, and tools an agent can call. No codegen, no decorators.
        </p>
        <div className={styles.ctas}>
          <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/quickstart">
            Get started →
          </Link>
          <a
            className={styles.btn}
            href="https://github.com/zeestack/dendra"
            target="_blank"
            rel="noreferrer"
          >
            Star on GitHub
          </a>
        </div>
        <div className={styles.install}>
          <span className={styles.dim}>$ </span>npm create dendra-app@latest
        </div>
      </section>

      <section className={styles.features}>
        {FEATURES.map((f) => (
          <div key={f.t} className={styles.card}>
            <h3 className={styles.cardTitle}>{f.t}</h3>
            <p className={styles.cardBody}>{f.b}</p>
          </div>
        ))}
      </section>

      <section className={styles.diagram}>
        <h2 className={styles.showcaseTitle}>one definition, many surfaces</h2>
        <p className={styles.diagramSub}>
          Your router is one object of procedures. dendra projects it into every
          surface — they can’t drift, because they all derive from the same spec.
        </p>
        <img
          className={styles.diagramImg}
          src="/dendra/img/arch-framework2.jpg"
          alt="dendra architecture: a router of procedures projects into a typed client, HTTP adapters (Next/Fetch/Node), REST + OpenAPI, an in-process caller, and a tool layer that becomes an MCP server and consumes external MCP"
        />
        <p className={styles.diagramLink}>
          <Link href="/architecture">See the full architecture →</Link>
        </p>
      </section>

      <section className={styles.showcase}>
        <h2 className={styles.showcaseTitle}>define → serve → call</h2>
        <div className={styles.window}>
          <div className={styles.windowBar}>
            <span className={styles.dot} data-c="r" />
            <span className={styles.dot} data-c="y" />
            <span className={styles.dot} data-c="g" />
            <span className={styles.windowTitle}>router.ts</span>
          </div>
          <pre className={styles.code}>
            <code
              className="hljs"
              dangerouslySetInnerHTML={{
                __html: hljs.highlight(CODE, { language: 'typescript' }).value
              }}
            />
          </pre>
        </div>
      </section>

      <footer className={styles.footer}>
        <Mark id="ftr" size={22} />
        <span>dendra — MIT licensed.</span>
        <div className={styles.spacer} />
        <Link href="/quickstart">Docs</Link>
        <a href="https://www.npmjs.com/package/dendra" target="_blank" rel="noreferrer">
          npm
        </a>
        <a href="https://github.com/zeestack/dendra" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </footer>
    </main>
  )
}
