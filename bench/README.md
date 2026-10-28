# Performance baselines

`npm run bench` measures the built package and compares it with
[`baseline.json`](baseline.json). CI runs it on every push and pull request, and
fails if a metric gets worse than its baseline by more than its margin.

```bash
npm run build && npm run bench             # compare
npm run build && npm run bench -- --update # rewrite baseline.json
```

| Metric | Measures | Margin |
| --- | --- | --- |
| `bundle.client` / `server` / `full` | min+gzip bytes an app ships for `createClient`, for `initDendra, s, toFetchHandler`, and for `export *` | 5% |
| `throughput.<scenario>` | ops/s of a bare fetch handler ÷ ops/s of dendra's, 32 calls in flight | 20% |
| `latency.<scenario>.p50` | dendra's median call time ÷ the bare handler's, one call at a time | 20% |
| `coldStart` | time for a fresh Node process to load the server and answer one request, dendra ÷ bare | 20% |

The scenarios are `unary` (POST with a validated object), `get` (a `.get()`
read with query input) and `stream` (20 NDJSON frames), all in process through
`toFetchHandler`. See [`scenarios.ts`](scenarios.ts).

**Why ratios.** Speed is scored against a hand-written handler doing the same
work in the same process, with the two measured in alternating rounds. So the
numbers mean "how much dendra costs", and a slow CI runner and a fast laptop
agree on them. Absolute ops/s, p50/p99 and cold start in ms are printed below
the table for reference, but aren't gated. p99 isn't gated because at a few µs
per call it measures GC pauses, not dendra.

**When a check fails.** If the cost is intended (a feature that has to do more
work), run `npm run bench -- --update` and commit `baseline.json` with the
change, saying why in the PR. If a change makes dendra faster or smaller,
update the baseline too, so the gain is kept. The baseline is taken on a CI
runner (Linux x64, Node 22). Take it there, or check that a local update
matches CI before you commit it.

Comparisons with tRPC and Hono (ROADMAP) aren't covered here.
