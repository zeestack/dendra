// Writes public/badges/npm-downloads-30d.json, a shields.io endpoint badge for
// dendra's downloads over the last 30 days. Shields' own monthly badge reads
// npm's `point/last-month`, which can serve a stale window (it showed 0 for a
// package with 1k+ downloads), so ask for an explicit date range instead.
// Fails the build rather than publish a wrong number; the last deploy stays up.

import { mkdirSync, writeFileSync } from "node:fs";

const day = (d) => d.toISOString().slice(0, 10);
const end = new Date(Date.now() - 86_400_000); // npm's counts lag about a day
const start = new Date(end.getTime() - 29 * 86_400_000);
const range = `${day(start)}:${day(end)}`;

const res = await fetch(`https://api.npmjs.org/downloads/point/${range}/dendra`);
if (!res.ok) throw new Error(`npm downloads API: HTTP ${res.status}`);
const { downloads, start: from, end: to } = await res.json();
if (typeof downloads !== "number" || from !== day(start) || to !== day(end)) {
  throw new Error(`npm downloads API: unexpected response for ${range}`);
}

mkdirSync("public/badges", { recursive: true });
writeFileSync(
  "public/badges/npm-downloads-30d.json",
  JSON.stringify({
    schemaVersion: 1,
    label: "downloads",
    message: `${downloads.toLocaleString("en-US")} / 30 days`,
    color: "5be3b3",
    cacheSeconds: 3600,
  }),
);
console.log(`dendra downloads ${range}: ${downloads}`);
