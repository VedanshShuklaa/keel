#!/usr/bin/env node
// `npm run chainstate` — regenerates every market-structure number Keel claims,
// live, from public endpoints. No wallet, no key, no funds. Judges can run this.
//
// Writes a timestamped JSON snapshot to data/ so a claim in the README can always
// be traced to the exact measurement that produced it.

import { writeFileSync, mkdirSync } from "node:fs";

const INDEXER = process.env.INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";
const PRICEFEED = process.env.PRICEFEED_URL ?? "https://price-feed.dev.oracle.somnia.host/v1/graphql";
const VENUE = process.env.VENUE_ID ?? "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c";
const PAGE_SIZE = 5_000;

async function gql(url, query, variables = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`${url}: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// Hasura caps rows per response, so a single large `limit` silently truncates and
// quietly understates every total. Page until a short page comes back.
async function gqlAll(url, buildQuery, variables = {}) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const data = await gql(url, buildQuery, { ...variables, limit: PAGE_SIZE, offset });
    const page = Object.values(data)[0];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

const now = Math.floor(Date.now() / 1000);

// --- 1. Venue-wide market and trade counts -------------------------------
const allMarkets = await gqlAll(
  INDEXER,
  `query($limit: Int!, $offset: Int!) {
    Market(
      where: { marketType: { _eq: "BINARY" } }
      order_by: { id: asc }
      limit: $limit
      offset: $offset
    ) {
      venueId asset tradeCount finalized
    }
  }`
);

const venues = {};
for (const m of allMarkets) {
  const v = (venues[m.venueId] ??= { markets: 0, trades: 0, neverTraded: 0, settled: 0 });
  v.markets++;
  v.trades += Number(m.tradeCount ?? 0);
  if (Number(m.tradeCount ?? 0) === 0) v.neverTraded++;
  if (m.finalized) v.settled++;
}
for (const v of Object.values(venues)) {
  v.neverTradedPct = Number(((100 * v.neverTraded) / v.markets).toFixed(1));
}
const dreamdex = venues[VENUE];

// --- 2. Live open windows and what is actually resting on their books -----
// `quantityRemaining > 0` alone is not enough: cancelled orders keep a non-zero
// remainder. Only status "Open" is genuinely on the book.
const { Market: liveMarkets } = await gql(
  INDEXER,
  `query($venue: String!, $now: numeric!) {
    Market(
      where: {
        venueId: { _eq: $venue }
        finalized: { _eq: false }
        marketType: { _eq: "BINARY" }
        expiry: { _gt: $now }
      }
      order_by: { expiry: asc }
      limit: 20
    ) {
      id asset intervalSec expiry tradeCount clobStatus
      orders(where: { status: { _eq: "Open" } }, limit: 500) {
        isBid price quantityRemaining owner
      }
    }
  }`,
  { venue: VENUE, now }
);

const windows = liveMarkets.map((m) => {
  const orders = m.orders ?? [];
  const bids = orders.filter((o) => o.isBid);
  const asks = orders.filter((o) => !o.isBid);
  return {
    asset: m.asset,
    intervalSec: Number(m.intervalSec),
    secondsToExpiry: Number(m.expiry) - now,
    trades: Number(m.tradeCount ?? 0),
    restingBids: bids.length,
    restingAsks: asks.length,
    twoSided: bids.length > 0 && asks.length > 0,
    distinctMakers: new Set(orders.map((o) => o.owner)).size,
  };
});

// --- 3. Asset coverage: what the oracle feeds vs what has a market --------
const { Symbol: symbols } = await gql(
  PRICEFEED,
  `query { Symbol(where: { active: { _eq: true } }, limit: 200) { symbol } }`
);
const oracleAssets = symbols.map((s) => s.symbol.split("/")[0]);

const coveredAssets = [...new Set(allMarkets.map((r) => r.asset))].sort();
const uncoveredAssets = oracleAssets.filter((a) => !coveredAssets.includes(a)).sort();

// --- 4. Series ever registered by anyone ---------------------------------
const { Series: seriesRows } = await gql(INDEXER, `query { Series { seriesId asset intervalSec } }`);
const seriesUnique = [...new Map(
  seriesRows.map((s) => [`${s.seriesId}:${s.asset}:${s.intervalSec}`, s])
).values()];

// --- report ---------------------------------------------------------------
const snapshot = {
  measuredAt: new Date(now * 1000).toISOString(),
  venueId: VENUE,
  marketsScanned: allMarkets.length,
  dreamdex,
  allVenues: venues,
  liveWindows: windows,
  oracleAssetCount: oracleAssets.length,
  oracleAssets,
  coveredAssets,
  uncoveredAssets,
  seriesRegistered: seriesUnique,
};

mkdirSync("data", { recursive: true });
const outPath = `data/chainstate-${new Date(now * 1000).toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`;
console.log(`\nKeel chainstate — measured ${snapshot.measuredAt}\n`);
console.log(`DreamDEX venue ${VENUE.slice(0, 10)}…`);
console.log(`  binary markets seen      ${dreamdex.markets}`);
console.log(`  trades, all time         ${dreamdex.trades}`);
console.log(`  never traded once        ${dreamdex.neverTraded}  (${pct(dreamdex.neverTraded, dreamdex.markets)})`);

console.log(`\nOther binary venues on the same chain:`);
for (const [id, v] of Object.entries(venues)) {
  if (id === VENUE) continue;
  console.log(`  ${id.slice(0, 10)}…  ${String(v.markets).padStart(5)} markets  ${String(v.trades).padStart(7)} trades  ${pct(v.neverTraded, v.markets)} never traded`);
}

console.log(`\nLive open windows on DreamDEX (${windows.length}):`);
console.log(`  asset  window     expires_in  trades  bids  asks  makers  two_sided`);
for (const w of windows) {
  console.log(
    `  ${w.asset.padEnd(5)}  ${String(w.intervalSec + "s").padEnd(9)}  ${String(w.secondsToExpiry + "s").padStart(10)}  ${String(w.trades).padStart(6)}  ${String(w.restingBids).padStart(4)}  ${String(w.restingAsks).padStart(4)}  ${String(w.distinctMakers).padStart(6)}  ${w.twoSided ? "yes" : "NO"}`
  );
}
const empty = windows.filter((w) => !w.twoSided).length;
console.log(`  ${empty} of ${windows.length} windows lack a two-sided book.`);

console.log(`\nAsset coverage:`);
console.log(`  oracle publishes         ${oracleAssets.length} assets`);
console.log(`  have Event Contracts     ${coveredAssets.length}  (${coveredAssets.join(", ")})`);
console.log(`  uncovered                ${uncoveredAssets.length}  (${uncoveredAssets.join(", ")})`);
console.log(`\nSeries ever registered:   ${seriesUnique.length}`);
for (const s of seriesUnique) console.log(`  seriesId ${s.seriesId}  ${s.asset}  ${s.intervalSec}s`);
console.log(`\nSnapshot written to ${outPath}\n`);
