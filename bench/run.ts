// Performance baselines (#41). Measures bundle size, throughput, latency and
// cold start against the built package, compares each with bench/baseline.json,
// and exits 1 if any got worse by more than its margin.
//
//   npm run build && npm run bench             # compare
//   npm run build && npm run bench -- --update # rewrite the baseline
//
// Speed is scored as a ratio to a bare handler doing the same work in the same
// process (see scenarios.ts), never in ops/s, so a slow CI runner and a fast
// laptop agree. Bundle sizes are exact bytes. Absolute numbers are printed for
// reference but not gated.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { bareHandler, call, dendraHandler, scenarios, type Scenario } from "./scenarios.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const BASELINE = here("./baseline.json");
const update = process.argv.includes("--update");

interface Metric {
  value: number;
  unit: string;
  /** How much worse than the baseline is allowed, as a fraction (0.05 = 5%). */
  margin: number;
  /** What the value means, printed next to it. */
  note: string;
}

const metrics: Record<string, Metric> = {};
const info: string[] = [];

// ---------------------------------------------------------------------------
// Bundle size: what an app ships for a typical import, minified and gzipped.
// ---------------------------------------------------------------------------

const bundles = {
  client: { code: `export { createClient } from "dendra";`, platform: "browser" },
  server: { code: `export { initDendra, s, toFetchHandler } from "dendra";`, platform: "node" },
  full: { code: `export * from "dendra";`, platform: "node" },
} as const;

for (const [name, { code, platform }] of Object.entries(bundles)) {
  const out = await build({
    stdin: { contents: code, resolveDir: here("."), loader: "js" },
    alias: { dendra: here("../dist/index.js") },
    bundle: true,
    minify: true,
    format: "esm",
    platform,
    write: false,
    logLevel: "silent",
  });
  const bytes = out.outputFiles[0].contents;
  metrics[`bundle.${name}`] = {
    value: gzipSync(bytes, { level: 9 }).length,
    unit: "B",
    margin: 0.05,
    note: `min+gzip of ${code.replace(/ from .*/, "")}`,
  };
}

// ---------------------------------------------------------------------------
// Throughput and latency, in process: dendra's fetch handler vs the bare one.
// ---------------------------------------------------------------------------

type Handler = (req: Request) => Promise<Response>;
const median = (xs: number[]) => quantile(xs, 0.5);
function quantile(xs: number[], q: number) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const CONCURRENCY = 32;
const ROUND_MS = 250;
const ROUNDS = 9;
const LATENCY_SAMPLES = 2000;

/** Calls completed per second with CONCURRENCY in flight, for ROUND_MS. */
async function opsPerSec(handler: Handler, scenario: Scenario) {
  let done = 0;
  const end = performance.now() + ROUND_MS;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (performance.now() < end) {
        await call(handler, scenario);
        done++;
      }
    }),
  );
  return done / ((performance.now() - start) / 1000);
}

/** Per-call times (µs), one call at a time. */
async function latencies(handler: Handler, scenario: Scenario, n: number) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await call(handler, scenario);
    out.push((performance.now() - t) * 1000);
  }
  return out;
}

for (const scenario of scenarios) {
  // Warm both up so the JIT has settled before anything is counted.
  for (const h of [dendraHandler, bareHandler]) await latencies(h, scenario, 3000);

  // Alternate dendra and bare rounds, so a slow patch on the machine hits both.
  const ratios: number[] = [];
  const dendraOps: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const d = await opsPerSec(dendraHandler, scenario);
    const b = await opsPerSec(bareHandler, scenario);
    ratios.push(b / d);
    dendraOps.push(d);
  }
  metrics[`throughput.${scenario.name}`] = {
    value: median(ratios),
    unit: "x",
    margin: 0.2,
    note: "bare ops/s ÷ dendra ops/s",
  };

  const dl: number[] = [];
  const bl: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    dl.push(...(await latencies(dendraHandler, scenario, LATENCY_SAMPLES / ROUNDS)));
    bl.push(...(await latencies(bareHandler, scenario, LATENCY_SAMPLES / ROUNDS)));
  }
  // p99 isn't gated: at a few µs per call it's GC pauses, not dendra.
  metrics[`latency.${scenario.name}.p50`] = {
    value: quantile(dl, 0.5) / quantile(bl, 0.5),
    unit: "x",
    margin: 0.2,
    note: "dendra p50 ÷ bare p50",
  };
  info.push(
    `${scenario.name}: ${Math.round(median(dendraOps)).toLocaleString("en")} ops/s, ` +
      `p50 ${quantile(dl, 0.5).toFixed(1)} µs, p99 ${quantile(dl, 0.99).toFixed(1)} µs`,
  );
}

// ---------------------------------------------------------------------------
// Cold start: a fresh process that loads the server and answers one request.
// ---------------------------------------------------------------------------

const COLD_RUNS = 21;

function coldStart(mode: "dendra" | "bare") {
  const t = performance.now();
  const r = spawnSync(process.execPath, [here("./cold-start.ts"), mode], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cold start (${mode}) failed:\n${r.stderr}`);
  return performance.now() - t;
}

coldStart("dendra"); // fill the OS file cache
const cold = { dendra: [] as number[], bare: [] as number[] };
for (let i = 0; i < COLD_RUNS; i++) {
  cold.dendra.push(coldStart("dendra"));
  cold.bare.push(coldStart("bare"));
}
metrics["coldStart"] = {
  value: median(cold.dendra) / median(cold.bare),
  unit: "x",
  margin: 0.2,
  note: "dendra process ÷ bare process (start, first response)",
};
info.push(
  `cold start: ${median(cold.dendra).toFixed(1)} ms (bare node ${median(cold.bare).toFixed(1)} ms)`,
);

// ---------------------------------------------------------------------------
// Report, and compare with the baseline.
// ---------------------------------------------------------------------------

const round = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 1000) / 1000);

if (update) {
  const values = Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, round(m.value)]));
  writeFileSync(
    BASELINE,
    JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, values }, null, 2) +
      "\n",
  );
}

const baseline: { values: Record<string, number> } = JSON.parse(readFileSync(BASELINE, "utf8"));
const failures: string[] = [];
const rows = Object.entries(metrics).map(([name, m]) => {
  const base = baseline.values[name];
  const limit = base === undefined ? undefined : base * (1 + m.margin);
  let status = "new";
  if (base !== undefined) {
    const change = (m.value - base) / base;
    status = `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
    if (m.value > limit!) {
      status += ` ✗ over ${round(limit!)}`;
      failures.push(name);
    }
  }
  return [name, `${round(m.value)} ${m.unit}`, base === undefined ? "—" : `${base} ${m.unit}`, status, m.note];
});

const table = [["metric", "now", "baseline", "change", ""], ...rows];
const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
for (const row of table) {
  console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());
}
console.log("\n" + info.join("\n"));

if (failures.length) {
  console.error(
    `\nRegressed past the margin: ${failures.join(", ")}.\n` +
      "If the cost is intended, run `npm run bench -- --update` and commit bench/baseline.json.",
  );
  process.exit(1);
}
