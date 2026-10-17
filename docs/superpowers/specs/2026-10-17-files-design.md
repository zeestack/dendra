# Files in and out — design

Status: approved with review fixes folded in (2026-10-17) · Source: [Question Tool request #1](../../requests/question-tool.md) · Target: dendra 0.7.0

## Why

Question Tool has five routes that can't be dendra procedures today: cover image,
product photo, product photo upload, Markdown download, CSV upload. Each one
re-implements the tenant check outside `.use()`, which is exactly where
cross-tenant leaks happen. The goal is that a file route is **just a procedure**:
same `.use()` chain, same `.after()` audit hooks, same typed client.

## Goals

- **File input:** `s.file({ types, maxBytes })` inside an ordinary `s.object`,
  sent as `multipart/form-data`, with the type checked from the file's **bytes**
  where the format has a signature — not only from the browser's header.
- **File output:** a handler returns `file(body, { type, filename, … })`; the
  server sends it as a raw response with `Content-Type`, `Content-Disposition`
  and `Cache-Control`, after the full `.use()` chain and `.after()` hooks.
- **Typed client:** accepts `File | Blob` for file fields, returns `Blob` for
  file outputs, and `urlFor(api.x.y, input)` gives a GET URL for `<img src>` /
  download links (auth rides on cookies, as with any same-origin request).
- Works through `toFetchHandler`/`toNextHandler`/`toNodeHandler`, `toRestHandler`,
  and `createCaller`. Core stays zero-dependency (Web `FormData`, `File`, `Blob`).

## Non-goals (v1)

- Streaming uploads to disk / object storage — bodies are buffered in memory,
  bounded by a size cap. (Question Tool's files are ≤ 8 MB.)
- Files nested below the top level of the input object, or arrays of files.
- Files over WebSocket or request batching — they return a clear error.
- Documenting file **outputs** in OpenAPI (file inputs are documented).
- Resumable/chunked uploads, signed URLs, storage adapters (that's the app).

## Anti-goals (would make this a failure even if it works)

- A file route that can skip `.use()` or `.after()`.
- A cross-site link, `<img>`, or form post that runs a mutation with the
  user's cookies (CSRF).
- A user-uploaded HTML/SVG file served inline that runs script on the app's origin.
- File contents ending up in audit logs via `.after()`.
- An upload that can exhaust server memory because the cap is checked only
  after the body is read.
- A renamed `.exe` passing as `image/png` because only the header was checked.
- Breaking any existing JSON call, client, or test.

## API

```ts
import { initDendra, s, file } from "dendra";

const covers = {
  upload: tenant
    .input(s.object({
      workspaceId: s.integer(),
      image: s.file({ types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 8_000_000 }),
    }))
    .handler(({ input, ctx }) => ctx.storage.put(input.workspaceId, input.image)), // input.image: File

  get: tenant
    .get()                                   // a read: reachable by GET / urlFor
    .input(s.object({ workspaceId: s.integer(), draftId: s.integer() }))
    .handler(async ({ input, ctx }) => {
      const obj = await ctx.storage.get(input.draftId);
      return file(obj.stream, { type: obj.type, filename: "cover.webp", inline: true,
                                cacheControl: "private, max-age=300", etag: obj.hash });
    }),

  exportMarkdown: tenant
    .get()
    .input(s.object({ draftId: s.integer() }))
    .handler(({ input, ctx }) =>
      file(ctx.drafts.toMarkdown(input.draftId), { type: "text/markdown", filename: "draft.md" })),

  importCsv: tenant
    .input(s.object({ workspaceId: s.integer(), csv: s.file({ types: ["text/csv", ".csv"] }) }))
    .handler(/* … */),
};
```

```ts
// client
await api.covers.upload({ workspaceId: 3, image: fileFromInput });   // → multipart
const blob = await api.covers.exportMarkdown({ draftId: 9 });          // → Blob
<img src={urlFor(api.covers.get, { workspaceId: 3, draftId: 9 })} />   // → GET URL
```

### `s.file(opts?)`

- `opts.types?: string[]` — MIME types (`"image/png"`) and/or extensions
  (`".csv"`, matched against the filename). Omitted = any type.
- `opts.maxBytes?: number` — per-file cap.
- Inferred type: `File`. Validation accepts any `Blob`; a bare `Blob` is wrapped
  into a `File` (name `"blob"`) so handlers always get a `File`.
- Validation is **async** (Standard Schema allows it): it reads the first bytes
  via `blob.slice(0, 16).arrayBuffer()` and checks them against a built-in
  signature table: PNG, JPEG, GIF, WebP, PDF, ZIP. Rule:
  - if the file's declared type has a signature in the table, the bytes must
    match it, and the matched type must be in `types`;
  - if the type has no signature (CSV, Markdown, plain text), the declared type
    **or** the filename extension must be in `types`.
  - Failure → `BAD_REQUEST` with an issue naming the field and the reason
    (`"expected image/png, image/jpeg or image/webp; got bytes of application/pdf"`).
- JSON Schema: `{ type: "string", format: "binary", contentMediaType?, maxLength? }`
  plus a non-standard `"x-dendra-file": true` marker that OpenAPI and the tool
  layer read.
- Chainable `.describe()`, like the other schemas.

### `file(body, opts)` (file output)

- `body: Blob | ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string`.
- `opts: { type: string; filename?: string; inline?: boolean; cacheControl?: string;
  etag?: string; allowUnsafeInline?: boolean; headers?: Record<string,string> }`.
- Returns a branded `FileResult`. Handler return type `FileResult` → client
  return type `Blob`.
- Server response: status 200, `Content-Type: type`, `Content-Disposition:
  attachment|inline; filename="…"; filename*=UTF-8''…` when `filename` is set,
  `Cache-Control` when given (default `private, no-store`), `X-Dendra: file`.
- **Response safety (always on):**
  - `X-Content-Type-Options: nosniff` on every file response.
  - `filename` is sanitized before it reaches the header: CR, LF, other control
    characters, `"` and `\` are stripped from the quoted `filename=` (ASCII
    fallback, non-ASCII → `_`); the full name goes only into the
    percent-encoded `filename*=`. No header injection, no broken quoting.
  - **Active types never render inline:** `text/html`, `application/xhtml+xml`,
    `image/svg+xml`, `text/xml`, `application/xml` (and any `+xml`) are forced to
    `attachment` even when `inline: true`, unless the handler sets
    `allowUnsafeInline: true`. _My call: downgrade to attachment rather than
    error, so the download still works; the type list goes beyond HTML/SVG
    because XHTML and XML documents can run script too._
  - Headers from `opts.headers` can't override `Content-Type`,
    `Content-Disposition` or `X-Content-Type-Options`.
- **ETag / 304:** with `etag` set, the response carries `ETag: "<etag>"`; if the
  request's `If-None-Match` matches, the server answers `304` with no body. (The
  handler still runs — it has to, to know the ETag — but no bytes are sent.
  Handlers can read `If-None-Match` from ctx to skip the fetch.)
- `createCaller` returns a `Blob` for a `FileResult` too, so the `Client<R>` type
  is honest on both paths.
- **`.after()` never sees file bytes:** for a `FileResult`, the hook's `result`
  is metadata only — `{ file: { type, filename, size? } }` (`size` when the
  body's length is known). File inputs stay `File` objects in `input` (typed as
  `In`); a `File` serializes to `{}`, so `JSON.stringify(input)` can't leak
  contents. The README tells audit hooks to log `name/type/size`.

### Wire format (RPC and REST)

- **Request with files:** the client sends `multipart/form-data` when any
  top-level input value is a `Blob`. Each Blob field becomes a file part under
  its key; every other field goes into one JSON part named `$input`. The server
  merges them: `{ ...JSON.parse($input), ...fileParts }`.
- **CSRF rules (RPC and REST):**
  - The typed client sends `X-Dendra: 1` on **every** request. A custom header
    can't be sent cross-site without a CORS preflight, so it proves the request
    came from a page allowed to call the API.
  - **Multipart requests require `X-Dendra: 1`** → otherwise `FORBIDDEN` (403).
  - **Plain HTML form posts** (multipart without `X-Dendra`/`$input`, or
    `application/x-www-form-urlencoded`) are rejected unless the server opts in
    with `allowFormPosts: true`; then string parts become fields (REST runs them
    through `coerceInput`) and CSRF protection is the app's job (e.g. a token
    checked in `.use()`). Docs say so next to the option.
  - **Every POST must be one of:** `Content-Type: application/json`;
    multipart with `X-Dendra: 1`; or a form type when `allowFormPosts` is on —
    otherwise `UNSUPPORTED_MEDIA_TYPE` (415). This applies even with an empty
    body: a cross-site `fetch(url, { method: "POST", mode: "no-cors" })` with no
    body and no `Content-Type` is a simple request (no preflight) and would
    otherwise run a no-input mutation. PUT/PATCH/DELETE (REST) always preflight
    cross-site, so they may omit `Content-Type` when the body is empty. This closes an existing hole: today a
    cross-site `text/plain` form post with a JSON body runs as a normal call.
    _My call — slightly breaking for non-dendra clients that POST without the
    header (e.g. `curl -d`); called out in release notes._
- **GET only reaches reads.** A procedure is a read when declared with `.get()`;
  `.get(path?)` now takes an optional path, so `.get()` alone marks a read
  without adding a REST route. On the RPC handler, GET for a non-read →
  `METHOD_NOT_ALLOWED` (405), and reads still accept POST from the client.
  This also closes an existing hole: today **any** procedure answers GET with
  input from the query string, so a cross-site `<img src>` could run a mutation.
  Procedures that return `file()` aren't treated as reads automatically — the
  server can't know a handler's return before running it — so file downloads
  used by `<img src>`/`urlFor` must be declared `.get()`. _My call; slightly
  breaking for anyone calling non-`.get()` procedures by GET._
- **Size cap:** a new server option `maxBodyBytes` (default **10 MB**) applies to
  multipart requests. It's checked against `Content-Length` before reading, and
  enforced while reading (the body is wrapped in a counting stream), so a
  chunked upload can't bypass it. Over the cap → new error code
  `PAYLOAD_TOO_LARGE` (413).
- **File response:** the client sees `X-Dendra: file` and returns `res.blob()`;
  a non-2xx response is still the JSON error envelope → `DendraClientError`.
  (A header, not the content type, because a downloaded file can itself be JSON.)
- **`urlFor(callable, input)`** builds `GET <base><prefix><path>?$input=<json>`.
  On GET (reads only), if a `$input` query param is present it's JSON-parsed as
  the input; otherwise today's flat query behaviour stays. `urlFor` on a
  procedure not declared `.get()` is a **type error** (the `Client<R>` type
  marks reads) and a runtime 405.
  The client proxy exposes its path through a private symbol, so a router key
  named `url` can't collide.
- Batching: calls with file input go direct, never into a batch. A `FileResult`
  inside a batch or over WebSocket → `NOT_IMPLEMENTED` error for that call.

### AI / MCP

- A procedure whose input contains `s.file()` **can't** be `.ai()`: `.handler()`
  / `.stream()` throws at definition time with a clear message. Models can't
  send bytes through tool calls, so exposing it would only produce broken tools.
- File outputs are off-limits to tools too: a tool whose handler returns a
  `FileResult` → the executor throws `"Tool 'x' returned a file; file outputs
  can't be tool results"`, and `.after()` records it as a failure. (Return types
  aren't known before the handler runs, so this is a runtime check; the docs
  say not to mark file-returning procedures `.ai()`.)

### OpenAPI

- File input → `requestBody` with `multipart/form-data`; file fields are
  `{ type: "string", format: "binary" }`, others as today.
- File output: not documented in v1 (non-goal).

## Constraints

- Zero runtime dependencies in core. Web-standard APIs only (`Request.formData`,
  `File`, `Blob`, `ReadableStream`); Node ≥ 20 has all of them.
- Non-breaking: JSON requests and responses are byte-for-byte unchanged.
- `Client<R>` keeps working with no codegen; file fields accept `File | Blob`.

## Decided by me (not discussed)

- `file()` helper rather than `.returns("file")`: the output type then comes
  from what the handler returns, no extra builder state.
- 10 MB default cap. New `ErrorCode`s: `PAYLOAD_TOO_LARGE` (413),
  `METHOD_NOT_ALLOWED` (405), `UNSUPPORTED_MEDIA_TYPE` (415).
- Signature table limited to the six formats above; extensions as an escape
  hatch for formats without one (CSV is often sent as `application/vnd.ms-excel`
  on Windows, so `".csv"` matters).
- Default `Cache-Control: private, no-store` (tenant data shouldn't be cached
  by shared caches unless the handler says so).
- Files only at the top level of the input object.

## Left to the builder

- Internal module layout (e.g. `src/files.ts` for the schema, sniffing,
  `FileResult`, multipart parsing).
- How the counting stream is wired for `toNodeHandler` vs fetch handlers.
- Exact issue-message wording.

## Done when

- Tests cover: multipart round-trip through `toFetchHandler` + `createClient`;
  REST multipart; byte sniffing rejecting a mislabeled file; extension fallback;
  `maxBytes` and `maxBodyBytes` (incl. a chunked body with no `Content-Length`);
  `FileResult` headers; client `Blob`; `urlFor` GET; caller returns `Blob`;
  `.use()` rejects before the handler on a file route; `.after()` sees the
  outcome with file metadata, never bytes; `.ai()` + file input throws; a tool
  returning a file throws; batch/WS errors; OpenAPI multipart.
- Security tests: GET on a non-`.get()` procedure → 405 (RPC); multipart without
  `X-Dendra` → 403; form posts rejected by default and accepted with
  `allowFormPosts`; `text/plain` JSON body → 415; `nosniff` on every file
  response; a filename with `"`, CR/LF is sanitized; `text/html` / `image/svg+xml`
  with `inline: true` served as attachment unless `allowUnsafeInline`; `ETag` +
  matching `If-None-Match` → 304 with no body.
- Type tests: `urlFor` rejects a non-`.get()` procedure; `input.image` is `File`; client accepts `File | Blob`; a
  `FileResult` handler gives the client `Promise<Blob>`.
- README, AGENTS.md, website features page, ROADMAP updated; version 0.7.0.
