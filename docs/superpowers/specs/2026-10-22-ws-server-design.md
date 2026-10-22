# WebSocket server with safe defaults — design

Status: draft, builder-checked (2026-10-22) · Source: [issue #1](https://github.com/zeestack/dendra/issues/1) · Target: dendra 0.9

## Why

`attachWs(socket, router, ctx)` runs calls and subscriptions over a socket that
is **already open**. Everything before and around that is left to each app:
accepting the upgrade, checking `Origin`, building the per-connection context,
size limits, dropping dead connections, re-checking long-lived sessions, and
shutting down cleanly. The README warns about the Origin check, which leaves
security to every app remembering it.

The first real app on dendra's WebSocket transport (question-tool) had to write
all of this itself, about 90 lines around `attachWs`. The next app should get
it safe by default with one call. This design is drawn from the `ws` library's
own guidance (auth in the HTTP `upgrade` event, ping/pong heartbeats) and
general practice, not lifted from that app.

## Goals

- `attachWsServer(wss, router, opts)` returns `{ handleUpgrade, closeWhere, close }`.
  The app keeps its own HTTP server and its own `ws` `WebSocketServer`
  (`noServer: true`); dendra decides, per upgrade, whether to accept it.
- **Origin allowlist is required.** Browsers apply no CORS to WebSockets, so any
  site can open one with the user's cookies (cross-site WebSocket hijacking).
- **One context model with HTTP:** `createContext(req: Request)`, the same
  signature as `toFetchHandler` / `toNextHandler`, run **once per connection**
  before the socket opens. Its `DendraError`s map to the HTTP status they
  already carry (401, 403, …).
- **Safe resource defaults:** a message size cap, a heartbeat, a cap on unsent
  bytes per connection, and a cap on open subscriptions per connection.
- **Long connections stay honest:** optional periodic `revalidate`, plus
  `closeWhere(ctx => …)` for app-driven closes (sign-out, removed membership).
- **Clean shutdown:** `close()` refuses new upgrades and closes open sockets
  with "going away".
- `onClose(ctx, { code, reason })` for presence, saving and audit.
- Core stays **zero-dependency** and runtime-agnostic in its types: `ws`,
  `node:http` and `node:stream` are matched structurally, never imported.

## Non-goals (v1)

- Bun (`Bun.serve({ websocket })`), Deno (`Deno.upgradeWebSocket`) and
  Cloudflare adapters. The design leaves room (the session is already
  transport-agnostic), but v1 targets Node + `ws`.
- Browser-side reconnect. That is a **separate follow-up PR**: a client that
  reconnects with jittered backoff, retries when the browser comes back online,
  and reports connected/reconnecting.
- Per-message rate limiting. Apps can do it in `.use()`; a message-rate cap may
  come later.
- Running inside a Next.js route handler — impossible (they can't accept
  upgrades). The README gets a recipe for a small Node server in front of Next.
- Changing `attachWs` / `createWsSession` / `connectWs` behaviour for existing
  callers.

## Anti-goals (would make this a failure even if it works)

- Any way to accept a browser connection without an Origin check by forgetting
  an option. "Allow all" must be spelled out.
- Opening the socket before auth finishes, or a rejected upgrade that still
  becomes a socket.
- One slow or malicious client growing server memory without bound (huge
  messages, unread subscription output, thousands of subscriptions).
- Kicking every user off when the auth backend blips for a moment.
- A shutdown that hangs because one client never answers the close handshake.

## API

```ts
import http from "node:http";
import { WebSocketServer } from "ws";
import { attachWsServer, DendraError } from "dendra";

const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });

const live = attachWsServer(wss, appRouter, {
  path: "/rpc/ws",
  allowedOrigins: ["https://app.example.com"],      // required
  createContext: async (req) => {
    const user = await getSession(req.headers);
    if (!user) throw new DendraError("UNAUTHORIZED", "Sign in required");
    return { user };
  },
  revalidate: { everyMs: 5 * 60_000, check: (ctx) => sessionStillValid(ctx.user) },
  onClose: (ctx, { code }) => presence.leave(ctx.user.id),
});

const server = http.createServer(nextHandler);
server.on("upgrade", (req, socket, head) => {
  if (!live.handleUpgrade(req, socket, head)) nextUpgrade(req, socket, head); // other paths fall through
});

// sign-out elsewhere in the app:
live.closeWhere((ctx) => ctx.user.id === userId);

// SIGTERM:
await live.close();
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `path` | required | Exact pathname to accept (query string ignored). Other paths → `handleUpgrade` returns `false` and touches nothing. |
| `allowedOrigins` | required | `string[]` of exact origins (`scheme://host[:port]`), or `(origin: string) => boolean`. `"*"` is not special; to allow all, pass `() => true`. |
| `allowMissingOrigin` | `false` | Accept upgrades with no `Origin` header (non-browser clients). Only safe when auth isn't cookie-based. |
| `createContext` | `() => ({})` | `(req: Request) => Ctx \| Promise<Ctx>`. Once per connection, before the socket opens. |
| `maxPayload` | `1_000_000` | Largest message in bytes. See "Message size". |
| `heartbeatMs` | `30_000` | Ping interval; a socket that misses one pong is terminated. `0` disables. |
| `maxBufferedBytes` | `1_000_000` | Unsent bytes allowed per socket before it's closed (slow consumer). |
| `maxSubscriptions` | `100` | Open subscriptions per connection; more get an error reply, the connection stays. |
| `revalidate` | none | `{ everyMs, check(ctx) => boolean \| Promise<boolean> }`. `false` → close `4401`. |
| `closeGraceMs` | `1_000` | How long `close()` / `closeWhere()` wait for the close handshake before terminating. |
| `onClose` | none | `(ctx, { code, reason }) => void \| Promise<void>`. Once per accepted connection. |
| `onError` | `console.error` with `[dendra] ws:` prefix | Errors from `createContext` (non-`DendraError`), `revalidate`, `onClose`, socket errors. |

### Returned handle

- `handleUpgrade(req, socket, head): boolean` — `true` if this path is ours (it
  then owns the socket: accepts or refuses it); `false` otherwise.
- `closeWhere(match: (ctx) => boolean, close?: { code?: number; reason?: string }): number`
  — closes matching connections (default `4401`, `"Unauthorized"`), returns how many.
- `close(): Promise<void>` — see "Shutdown". Idempotent.
- `size: number` — open connections (for metrics and tests).

## Behaviour

### Upgrade, in order

1. Pathname ≠ `path` → return `false`.
2. Attach an `error` listener to the raw socket for the duration of the
   handshake (per the `ws` docs; an unhandled socket error would crash Node).
3. Shutting down → refuse `503`.
4. Origin check: missing and `!allowMissingOrigin`, or not allowed → refuse `403`.
5. Build a Web `Request` from the upgrade: `GET`, URL from `Host` + `req.url`
   (`http://` scheme; `localhost` if `Host` is missing), all headers (repeated
   headers appended). Call `createContext(request)`.
   - Throws `DendraError` → refuse with `err.status` (401, 403, …).
   - Throws anything else → refuse `500`, report to `onError`.
6. Shutting down by now → refuse `503` (shutdown can start while `createContext`
   awaits).
7. Socket destroyed meanwhile (client gave up) → stop quietly.
8. `wss.handleUpgrade(...)` → the socket opens; wire the session (below).

A refusal writes a minimal response (`HTTP/1.1 <status> <reason>`,
`Connection: close`, `Content-Length: 0`) and destroys the socket. No body, so
nothing about the failure leaks.

### Per connection

- A `createWsSession(router, send, ctx, { maxSubscriptions })` on the socket.
  `ctx` is the object from `createContext`, shared by every call on this
  connection.
- **Send only while open.** A unary call can finish after its socket closed;
  its reply is dropped, never sent to a closing socket.
- **Send path checks backpressure.** Before each send, if
  `socket.bufferedAmount > maxBufferedBytes`, close with `1013` ("Try Again
  Later") instead of queuing more. Subscription output is the usual culprit.
- **Heartbeat:** one interval per `attachWsServer` (not per socket). Each tick:
  a socket that hasn't answered the previous ping is `terminate()`d; otherwise
  mark it unanswered and `ping()`. A `pong` marks it alive.
- **Revalidate:** one interval per `attachWsServer`; runs `check(ctx)` for each
  connection, at most one check in flight per connection. `false` → close
  `4401`. A **throw** keeps the connection and goes to `onError` (a blip in the
  auth backend must not log everyone out).
- **On close** (any cause, including `closeWhere`, `close()`, a missed
  heartbeat): the session aborts all its subscriptions, the connection leaves
  the live set, `onClose(ctx, { code, reason })` runs once (`reason` as a
  string); its throw/rejection goes to `onError`.

### Message size

`ws` buffers a whole message before handing it over, and its own default
`maxPayload` is 100 MiB. dendra can't change the `ws` server's option after it
is built, so:

- If the `ws` server exposes `options.maxPayload` and it is larger than
  dendra's `maxPayload`, **`attachWsServer` throws** at startup, saying to pass
  `maxPayload` to `new WebSocketServer(...)`. Fail fast, not in production.
- `ws` itself then closes oversize messages with `1009`.
- If the server doesn't expose `options` (a different library), dendra also
  checks each message's byte length and closes with `1009` when it is over.

### Subscription cap

`createWsSession` gains an optional 4th argument `{ maxSubscriptions?: number }`
(default unlimited, so `attachWs` is unchanged). Over the cap, a `subscribe` gets
`{ type: "error", error: { code: "TOO_MANY_REQUESTS", … } }` and nothing starts.

### Shutdown

`close()`:
1. Marks shutting down (new upgrades → `503`), clears the heartbeat and
   revalidate intervals.
2. Closes each socket with `1001` ("Going Away" — the standard code for a server
   going down; clients reconnect, ideally to another instance).
3. After `closeGraceMs`, `terminate()`s any socket still open.
4. Resolves when every socket has closed and every `onClose` has settled.

It doesn't close the `ws` server or the HTTP server; the app owns those.

### Close codes

| Code | When |
|---|---|
| `1001` | `close()` (server going away) |
| `1009` | Message over `maxPayload` |
| `1013` | Unsent backlog over `maxBufferedBytes` |
| `4401` | `revalidate` returned `false`; default for `closeWhere` |
| (terminate) | Missed heartbeat |

Codes `4000–4999` are the range the WebSocket spec leaves to applications;
`4401` mirrors HTTP 401 so clients can tell "sign in again" from "reconnect".

### Structural types (no imports from `ws` or Node)

```ts
interface WsUpgradeRequest { url?: string; headers: Record<string, string | string[] | undefined> }
interface WsUpgradeSocket { write(data: string): unknown; destroy(): void; destroyed?: boolean;
                            on(e: "error", cb: (err: Error) => void): unknown;
                            off(e: "error", cb: (err: Error) => void): unknown }
interface WsServerSocket extends WsLikeSocket {
  ping(): void; terminate(): void; close(code?: number, reason?: string): void;
  readonly bufferedAmount: number; on(e: "pong", cb: () => void): void; /* + close(code, reason) */ }
interface WsServerLike {
  handleUpgrade(req: any, socket: any, head: any, cb: (ws: WsServerSocket) => void): void;
  options?: { maxPayload?: number };
}
```

A `ws` `WebSocketServer`, `http.IncomingMessage` and `stream.Duplex` must fit
these without casts. A type test (`*.test-d.ts`) against real `ws` types
enforces it; `ws` + `@types/ws` become dev dependencies only.

## Constraints

- Zero runtime dependencies in core; Node ≥ 22 globals (`Request`, `Headers`,
  `TextEncoder`) are fine.
- Existing exports keep their behaviour; `createWsSession`'s new argument is
  optional.
- Error replies over the socket reuse `toErr` as today.

## Decided by me (not discussed)

The user handed these calls to me; they're best-practice defaults, open to
change in review:

- No-Origin upgrades are rejected unless `allowMissingOrigin: true`.
- Origin failure is `403` (it's a policy refusal, not missing credentials);
  auth failure uses the `DendraError`'s status.
- Startup throws when the `ws` server allows bigger messages than `maxPayload`.
- Defaults: 1 MB messages, 30 s heartbeat, 1 MB unsent backlog, 100
  subscriptions, 1 s close grace.
- `revalidate` errors keep the connection; only `false` closes it.
- Shutdown uses `1001`, not `1012`.
- Over the subscription cap is an error reply, not a disconnect.
- The `Request` URL is always `http://` + `Host`; `X-Forwarded-Proto` is not
  trusted (dendra can't know whether a proxy is in front). Only matters to a
  `createContext` that reads `req.url`.
- One shared heartbeat/revalidate timer per server, not one per socket.
- Browser reconnect is a separate, later PR.

## Left to the builder

- File layout (`src/ws-server.ts` beside `src/ws.ts`, or inside `ws.ts`).
- Exact wording of error messages and `onError` reports.
- Whether timers are `unref()`'d when the runtime supports it (they should not
  keep a process alive on their own).
- Test structure, as long as "Done when" is covered.

## Done when

- Tests over a real `http` server + real `ws` (dev dependency) cover: wrong
  path falls through; missing / wrong Origin → 403; `allowMissingOrigin`;
  `createContext` throwing `UNAUTHORIZED` → 401 and a plain `Error` → 500 with
  `onError`; context reaches procedures; heartbeat terminates a socket that
  stops answering pings; oversize message → 1009; startup throws on a too-large
  `ws` `maxPayload`; backlog → 1013; subscription cap → `TOO_MANY_REQUESTS`;
  revalidate `false` → 4401, throw → stays open; `closeWhere`; `close()` → 503
  for new upgrades, 1001 for open ones, terminate after grace, resolves after
  `onClose`s; `onClose` runs exactly once per connection.
- Type test: a real `WebSocketServer`, `IncomingMessage` and `Duplex` fit the
  structural types.
- README: replace the "check Origin yourself" warning with `attachWsServer`,
  add the "Node server in front of Next" recipe. AGENTS.md, ARCHITECTURE.md,
  the dendra skill and ROADMAP updated. `examples/rest-ws-demo.ts` uses it.
- Typecheck, build, full test suite green.
