#!/usr/bin/env node
// Day 2-3 deliverable: replay the Phi(d) pricer over every settled DreamDEX
// Event Contract window and score it with Brier score against a flat-0.5
// baseline. Read-only — no wallet, no funds, no SDK required.
//
// Data sources (verified live 2026-08-24, see memory/somnia-testnet-verified-constants.md):
//   Indexer    https://dev.smk.somnia.host/v1/graphql        -> Market (settled outcomes)
//   Price feed https://price-feed.dev.oracle.somnia.host/v1/graphql -> PricePoint (oracle tick history)

import { sigmaPerSecond, fairValue } from "./pricer.js";

const INDEXER_URL = "https://dev.smk.somnia.host/v1/graphql";
const PRICEFEED_URL = "https://price-feed.dev.oracle.somnia.host/v1/graphql";
const DREAMDEX_VENUE_ID =
  "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c";

const MARKET_LIMIT = Number(process.argv[2] || 300);
const SIGMA_TRAIN_TICKS = 1000;
const SNAPSHOT_FRACTIONS = [0.25, 0.5, 0.75, 0.9, 0.98];
const PRICE_SCALE = 1e18;

async function gql(url, query, variables) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchFinalizedMarkets(limit) {
  const data = await gql(
    INDEXER_URL,
    `query($venue: String!, $limit: Int!) {
      Market(
        where: { venueId: { _eq: $venue }, finalized: { _eq: true }, voided: { _eq: false }, marketType: { _eq: "BINARY" } }
        order_by: { resolvedAtTimestamp: desc }
        limit: $limit
      ) {
        id asset tradingStart expiry resolvedAtTimestamp intervalSec winningOutcome
      }
    }`,
    { venue: DREAMDEX_VENUE_ID, limit }
  );
  return data.Market;
}

async function fetchTicks(symbol, fromTs, toTs) {
  const data = await gql(
    PRICEFEED_URL,
    `query($symbol: String!, $from: numeric!, $to: numeric!) {
      PricePoint(
        where: { symbol: { _eq: $symbol }, blockTimestamp: { _gte: $from, _lte: $to } }
        order_by: { blockTimestamp: asc }
        limit: 5000
      ) { spot blockTimestamp }
    }`,
    { symbol, from: fromTs, to: toTs }
  );
  return data.PricePoint.map((p) => ({
    t: Number(p.blockTimestamp),
    price: Number(p.spot) / PRICE_SCALE,
  }));
}

function nearestAtOrBefore(ticks, ts) {
  let chosen = null;
  for (const tick of ticks) {
    if (tick.t <= ts) chosen = tick;
    else break;
  }
  return chosen;
}

async function backtestMarket(market, stats, sample, agreement) {
  const asset = market.asset;
  const symbol = `${asset}/USDC`;
  const tradingStart = Number(market.tradingStart);
  const expiry = Number(market.expiry);
  const duration = expiry - tradingStart;
  if (!(duration > 0)) return "skipped_bad_window";

  // Causal training window: only ticks strictly before the market opened.
  const trainData = await gql(
    PRICEFEED_URL,
    `query($symbol: String!, $before: numeric!, $limit: Int!) {
      PricePoint(
        where: { symbol: { _eq: $symbol }, blockTimestamp: { _lt: $before } }
        order_by: { blockTimestamp: desc }
        limit: $limit
      ) { spot blockTimestamp }
    }`,
    { symbol, before: tradingStart, limit: SIGMA_TRAIN_TICKS }
  );
  const trainTicks = trainData.PricePoint
    .map((p) => ({ t: Number(p.blockTimestamp), price: Number(p.spot) / PRICE_SCALE }))
    .sort((a, b) => a.t - b.t);
  if (trainTicks.length < 50) return "skipped_no_training_data";
  const sigmaS = sigmaPerSecond(trainTicks);
  if (!sigmaS) return "skipped_no_sigma";

  const windowTicks = await fetchTicks(symbol, tradingStart, expiry + 5);
  if (windowTicks.length < 5) return "skipped_no_window_ticks";

  const openTick = nearestAtOrBefore(windowTicks, tradingStart) || windowTicks[0];
  const K = openTick.price;
  const finalTick = windowTicks[windowTicks.length - 1];
  const actualUp = finalTick.price >= K ? 1 : 0;

  // Market.question is phrased "<ASSET> closes at or above its opening
  // price"; payoutNumerators/winningOutcome index 0 corresponds to that
  // (Yes/Up) outcome, index 1 to No/Down.
  const onChainUp = Number(market.winningOutcome) === 0 ? 1 : 0;
  agreement.total++;
  if (onChainUp === actualUp) agreement.matched++;
  else if (agreement.mismatches.length < 5) {
    agreement.mismatches.push({
      id: market.id.slice(-6),
      asset,
      K: K.toFixed(2),
      final: finalTick.price.toFixed(2),
      pctMove: (((finalTick.price - K) / K) * 100).toFixed(4) + "%",
    });
  }

  for (const frac of SNAPSHOT_FRACTIONS) {
    const tSnap = tradingStart + frac * duration;
    const snapTick = nearestAtOrBefore(windowTicks, tSnap);
    if (!snapTick) continue;
    const tau = expiry - snapTick.t;
    if (tau < 0) continue;

    const S = snapTick.price;
    const modelP = fairValue(S, K, tau, sigmaS);
    const baseP = 0.5;

    const bucket = stats[frac];
    bucket.n++;
    bucket.modelSqErr += (modelP - actualUp) ** 2;
    bucket.baseSqErr += (baseP - actualUp) ** 2;
  }

  return "ok";
}

async function main() {
  console.log(`Fetching up to ${MARKET_LIMIT} finalized BINARY markets on DreamDEX venue...`);
  const markets = await fetchFinalizedMarkets(MARKET_LIMIT);
  console.log(`Got ${markets.length} settled markets.`);

  const stats = {};
  for (const f of SNAPSHOT_FRACTIONS) stats[f] = { n: 0, modelSqErr: 0, baseSqErr: 0 };
  const outcomes = { skipped: {}, ok: 0 };
  const sample = [];
  const agreement = { total: 0, matched: 0, mismatches: [] };

  let done = 0;
  for (const market of markets) {
    const result = await backtestMarket(market, stats, sample, agreement);
    if (result === "ok") outcomes.ok++;
    else outcomes.skipped[result] = (outcomes.skipped[result] || 0) + 1;
    done++;
    if (done % 25 === 0) console.log(`  ...${done}/${markets.length}`);
  }

  console.log(
    `\nSanity check — price-derived outcome (open/close ticks from PricePoint) vs on-chain winningOutcome: ` +
      `${agreement.matched}/${agreement.total} agree (${((100 * agreement.matched) / agreement.total).toFixed(1)}%)`
  );
  if (agreement.mismatches.length) {
    console.log("Sample disagreements (near-tie windows, expected from tick-timing granularity):");
    for (const m of agreement.mismatches) console.log(" ", JSON.stringify(m));
  }

  console.log(`\nMarkets scored: ${outcomes.ok} / ${markets.length}`);
  if (Object.keys(outcomes.skipped).length) {
    console.log("Skipped:", outcomes.skipped);
  }

  console.log("\nBrier score by time-elapsed snapshot (lower is better; flat-0.5 baseline = 0.25):");
  console.log("  elapsed  n     model_brier   baseline_brier   beats_baseline");
  let totalN = 0, totalModel = 0, totalBase = 0;
  for (const f of SNAPSHOT_FRACTIONS) {
    const b = stats[f];
    if (b.n === 0) continue;
    const modelBrier = b.modelSqErr / b.n;
    const baseBrier = b.baseSqErr / b.n;
    totalN += b.n; totalModel += b.modelSqErr; totalBase += b.baseSqErr;
    console.log(
      `  ${(f * 100).toFixed(0).padStart(5)}%  ${String(b.n).padStart(4)}  ${modelBrier.toFixed(4).padStart(11)}   ${baseBrier.toFixed(4).padStart(13)}   ${modelBrier < baseBrier ? "yes" : "NO"}`
    );
  }
  if (totalN > 0) {
    console.log(
      `\nOverall: n=${totalN}  model_brier=${(totalModel / totalN).toFixed(4)}  baseline_brier=${(totalBase / totalN).toFixed(4)}`
    );
  } else {
    console.log("\nNo scoreable snapshots — check skip reasons above.");
  }
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
