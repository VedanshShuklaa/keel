#!/usr/bin/env node
// Runner for the mintSet/burnSet maker strategy simulation described in
// the task brief. Fetches real settled DreamDEX BINARY windows plus their
// oracle tick history and their historical Fill (trade) records, replays
// worker/marketmaker.js's simulateWindow() against them, and prints an
// honest per-window + aggregate report, plus a markup/re-quote-threshold
// sensitivity sweep. Read-only GraphQL only -- no wallet, no keys, no
// transactions.
//
// Usage:
//   node worker/mmbacktest.js [marketLimit]
//
// All network-fetched data is cached under data/cache/ (gitignored) so a
// re-run (e.g. to sweep more parameter combinations) does not re-hit the
// network. Delete data/cache/mm-*.json to force a refetch.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { sigmaPerSecond } from "./pricer.js";
import { simulateWindow } from "./marketmaker.js";
import { DEFAULT_CONFIG as SPREAD_POLICY_DEFAULT_CONFIG } from "./spreadPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "data", "cache");

const INDEXER_URL = "https://dev.smk.somnia.host/v1/graphql";
const PRICEFEED_URL = "https://price-feed.dev.oracle.somnia.host/v1/graphql";
const DREAMDEX_VENUE_ID =
  "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c";

const MARKET_LIMIT = Number(process.argv[2] || 300);
const SIGMA_TRAIN_TICKS = 1000;
const PRICE_SCALE = 1e18; // PricePoint.spot scaling (matches worker/backtest.js)

// Default single-run simulation parameters (also the center of the sweep).
const DEFAULT_MARKUP = 0.01;
const DEFAULT_REQUOTE_THRESHOLD = 0.01;
const DEFAULT_MINT_SIZE = 1;
const DEFAULT_GAS_COST = 0.0005; // symbolic burnSet/cleanup gas, see docs/MM-BACKTEST.md

const MARKUP_SWEEP = [0.005, 0.01, 0.02, 0.05];
const THRESHOLD_SWEEP = [0.005, 0.01, 0.02];

// --- Round 2: SpreadPolicy (defenses 1+2) + leftover-leg unwind (defense 3) ---
// skewCoef/refTau/maxUrgencyMult/minSpread/maxSpread are pinned to
// contracts/test/SpreadPolicy.t.sol's exact config -- these mirror the
// deployed on-chain policy, they are not free strategy dials for this
// backtest. baseSpread and unwind.aggressiveness ARE the strategy dials,
// so those two are what get swept, jointly (see runRound2SweepPoint()).
const ROUND2_MIN_SPREAD = 0.005;
const ROUND2_MAX_SPREAD = 0.08;
const ROUND2_REF_TAU = 900;
const ROUND2_SKEW_COEF = 0.5;
const ROUND2_MAX_URGENCY_MULT = 6;
const DEFAULT_BASE_SPREAD = 0.015; // == SPREAD_POLICY_DEFAULT_CONFIG.baseSpread
const DEFAULT_UNWIND_AGGRESSIVENESS = 0.02;

const BASE_SPREAD_SWEEP = [0.005, 0.01, 0.015, 0.02, 0.05];
const UNWIND_AGGRESSIVENESS_SWEEP = [0, 0.005, 0.01, 0.02, 0.05];

function spreadPolicyConfig(baseSpread) {
  return {
    baseSpread,
    minSpread: ROUND2_MIN_SPREAD,
    maxSpread: ROUND2_MAX_SPREAD,
    refTau: ROUND2_REF_TAU,
    skewCoef: ROUND2_SKEW_COEF,
    maxUrgencyMult: ROUND2_MAX_URGENCY_MULT,
  };
}

// --- tiny disk cache --------------------------------------------------

function cachePath(name) {
  return path.join(CACHE_DIR, `${name}.json`);
}

function cacheGet(name) {
  const p = cachePath(name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function cacheSet(name, data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(name), JSON.stringify(data));
}

// --- GraphQL fetch helpers ---------------------------------------------
// (Deliberately duplicated from worker/backtest.js rather than imported --
// backtest.js is not modularized for import and is off-limits to edit.)

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

// The "most recent N finalized markets" result is a moving target -- new
// windows keep settling on the venue, so re-running this query at a later
// wall-clock time returns a DIFFERENTLY-SHIFTED set of markets even with
// the same `limit`. Round 2 of this backtest hit exactly that: the
// round-1 report and the round-2 report were generated in the same
// session but at different times, and their top-level totals are
// therefore not from byte-identical samples (see docs/MM-BACKTEST.md).
// Caching the market LIST itself (not just each market's ticks/fills)
// pins the sample across re-runs from here on, so any single invocation's
// round-1-vs-round-2 comparison is always apples-to-apples (same
// `windows` array, see main()), and repeat runs reproduce exactly.
// Delete data/cache/markets-<limit>.json to intentionally refresh to the
// current "most recent N".
async function fetchFinalizedMarkets(limit) {
  const cacheName = `markets-${limit}`;
  const cached = cacheGet(cacheName);
  if (cached) return cached;
  const data = await gql(
    INDEXER_URL,
    `query($venue: String!, $limit: Int!) {
      Market(
        where: { venueId: { _eq: $venue }, finalized: { _eq: true }, voided: { _eq: false }, marketType: { _eq: "BINARY" } }
        order_by: { resolvedAtTimestamp: desc }
        limit: $limit
      ) {
        id asset tradingStart expiry resolvedAtTimestamp intervalSec winningOutcome
        quoteDecimals baseDecimals
      }
    }`,
    { venue: DREAMDEX_VENUE_ID, limit }
  );
  cacheSet(cacheName, data.Market);
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

async function fetchTrainTicks(symbol, before, limit) {
  const data = await gql(
    PRICEFEED_URL,
    `query($symbol: String!, $before: numeric!, $limit: Int!) {
      PricePoint(
        where: { symbol: { _eq: $symbol }, blockTimestamp: { _lt: $before } }
        order_by: { blockTimestamp: desc }
        limit: $limit
      ) { spot blockTimestamp }
    }`,
    { symbol, before, limit }
  );
  return data.PricePoint
    .map((p) => ({ t: Number(p.blockTimestamp), price: Number(p.spot) / PRICE_SCALE }))
    .sort((a, b) => a.t - b.t);
}

// Fill.fillPrice is always expressed in the shared Up/YES-probability
// convention, even for BUY_NO fills (verified empirically against live
// Fill rows: quoteQuantity == quantity * fillPrice regardless of side --
// see the session's schema exploration notes). SELL_YES/SELL_NO takerSide
// rows are the taker crossing a resting BID, which our asks-only strategy
// never posts, so they're irrelevant and dropped here.
async function fetchFills(marketId) {
  const data = await gql(
    INDEXER_URL,
    `query($m: String!) {
      Fill(where: { market_id: { _eq: $m } }, order_by: { timestamp: asc }, limit: 5000) {
        timestamp fillPrice quantity takerSide
      }
    }`,
    { m: marketId }
  );
  return data.Fill;
}

function nearestAtOrBefore(ticks, ts) {
  let chosen = null;
  for (const tick of ticks) {
    if (tick.t <= ts) chosen = tick;
    else break;
  }
  return chosen;
}

// --- per-market fetch + transform (network side, cached) --------------

async function loadWindowData(market) {
  const cacheName = `mm-window-${market.id}`;
  const cached = cacheGet(cacheName);
  if (cached) return cached;

  const asset = market.asset;
  const symbol = `${asset}/USDC`;
  const tradingStart = Number(market.tradingStart);
  const expiry = Number(market.expiry);
  const duration = expiry - tradingStart;
  if (!(duration > 0)) return { skip: "bad_window" };

  // Causal sigma training: strictly ticks before tradingStart. This is the
  // ONLY place sigma is computed in the whole pipeline -- marketmaker.js
  // never trains sigma itself, it only consumes the scalar produced here,
  // so there is no code path for within-window information to leak into it.
  const trainTicks = await fetchTrainTicks(symbol, tradingStart, SIGMA_TRAIN_TICKS);
  if (trainTicks.length < 50) return { skip: "no_training_data" };
  const sigmaS = sigmaPerSecond(trainTicks);
  if (!sigmaS) return { skip: "no_sigma" };

  const windowTicks = await fetchTicks(symbol, tradingStart, expiry + 5);
  if (windowTicks.length < 5) return { skip: "no_window_ticks" };

  const openTick = nearestAtOrBefore(windowTicks, tradingStart) || windowTicks[0];
  const K = openTick.price;

  const quoteScale = 10 ** Number(market.quoteDecimals ?? 6);
  const baseScale = 10 ** Number(market.baseDecimals ?? 6);

  const rawFills = await fetchFills(market.id);
  const trades = [];
  for (const f of rawFills) {
    const t = Number(f.timestamp);
    const rawUpPrice = Number(f.fillPrice) / quoteScale; // shared Up-probability convention
    const quantity = Number(f.quantity) / baseScale;
    if (f.takerSide === "BUY_YES") {
      trades.push({ t, side: "UP", price: rawUpPrice, quantity });
    } else if (f.takerSide === "BUY_NO") {
      // Down price = 1 - (shared Up-convention price). See fetchFills() comment.
      trades.push({ t, side: "DOWN", price: 1 - rawUpPrice, quantity });
    }
    // SELL_YES / SELL_NO taker fills cross a resting BID; our asks-only
    // strategy never posts one, so those rows can't interact with us.
  }
  trades.sort((a, b) => a.t - b.t);

  const outcomeUp = Number(market.winningOutcome) === 0;

  const result = {
    marketId: market.id,
    asset,
    tradingStart,
    expiry,
    K,
    sigmaS,
    outcomeUp,
    windowTicks,
    trades,
  };
  cacheSet(cacheName, result);
  return result;
}

// --- report helpers -----------------------------------------------------

function runSweepPoint(windows, markup, requoteThreshold) {
  const results = windows.map((w) =>
    simulateWindow({
      tradingStart: w.tradingStart,
      expiry: w.expiry,
      K: w.K,
      sigmaS: w.sigmaS,
      outcomeUp: w.outcomeUp,
      ticks: w.windowTicks,
      trades: w.trades,
      markup,
      requoteThreshold,
      mintSize: DEFAULT_MINT_SIZE,
      gasCost: DEFAULT_GAS_COST,
    })
  );
  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  return { totalPnl, avgPnl: results.length ? totalPnl / results.length : 0, n: results.length };
}

function fmt(n, d = 4) {
  return Number(n).toFixed(d);
}

function printReport(windows, results) {
  console.log("\nPer-window PnL (most recent first):");
  console.log("  asset     tradingStart  pnl        upFilled  downFilled  outcome");
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i], r = results[i];
    console.log(
      `  ${w.asset.padEnd(8)}  ${w.tradingStart}  ${fmt(r.pnl).padStart(9)}  ` +
        `${fmt(r.upFilled, 2).padStart(8)}  ${fmt(r.downFilled, 2).padStart(10)}  ${w.outcomeUp ? "Up" : "Down"}`
    );
  }

  const n = results.length;
  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  const both = results.filter((r) => r.bothSidesFilled).length;
  const one = results.filter((r) => r.oneSideFilled).length;
  const neither = results.filter((r) => r.neitherSideFilled).length;
  const upFillWindows = results.filter((r) => r.upFilled > 0).length;
  const downFillWindows = results.filter((r) => r.downFilled > 0).length;
  const worst = Math.min(...results.map((r) => r.pnl));
  const best = Math.max(...results.map((r) => r.pnl));

  // Chronological order for the drawdown/cumulative sequence (windows were
  // fetched most-recent-first for the report table above).
  const chrono = windows
    .map((w, i) => ({ w, r: results[i] }))
    .sort((a, b) => a.w.tradingStart - b.w.tradingStart);
  let cum = 0, peak = 0, maxDrawdown = 0;
  for (const { r } of chrono) {
    cum += r.pnl;
    peak = Math.max(peak, cum);
    maxDrawdown = Math.min(maxDrawdown, cum - peak);
  }

  // Spread captured vs adverse-selection decomposition. This is an
  // APPROXIMATION: it assumes every matched (both-sides-filled) unit was
  // priced off the same P snapshot for both legs, so askUp+askDown-1 ==
  // 2*markup exactly. If the quote moved between the Up fill and the Down
  // fill for a given unit, the true riskless component differs slightly
  // from this estimate -- the residual (adverseSelection) absorbs that
  // drift along with genuine directional P&L and the burn/gas cost.
  const spreadCaptured = results.reduce(
    (s, r) => s + Math.min(r.upFilled, r.downFilled) * 2 * DEFAULT_MARKUP,
    0
  );
  const adverseSelection = totalPnl - spreadCaptured;

  console.log(`\n=== Aggregate report (markup=${DEFAULT_MARKUP}, requoteThreshold=${DEFAULT_REQUOTE_THRESHOLD}, gasCost=${DEFAULT_GAS_COST}) ===`);
  console.log(`Windows simulated: ${n}`);
  console.log(`Total PnL: ${fmt(totalPnl)}`);
  console.log(`PnL per window (avg): ${fmt(n ? totalPnl / n : 0)}`);
  console.log(`Fill rate: Up filled in ${upFillWindows}/${n} windows, Down filled in ${downFillWindows}/${n} windows`);
  console.log(`Both sides filled: ${both}/${n}  |  One side filled: ${one}/${n}  |  Neither filled: ${neither}/${n}`);
  console.log(`Spread captured (approx, riskless component): ${fmt(spreadCaptured)}`);
  console.log(`Adverse-selection / drift residual: ${fmt(adverseSelection)}`);
  console.log(`Worst single-window loss: ${fmt(worst)}`);
  console.log(`Best single-window PnL: ${fmt(best)}`);
  console.log(`Max drawdown (chronological cumulative PnL): ${fmt(maxDrawdown)}`);

  console.log("\n=== Sensitivity sweep (total PnL / avg PnL per window) ===");
  const COL = 18;
  const header = ["threshold\\markup", ...MARKUP_SWEEP.map((s) => `s=${s}`)];
  console.log("  " + header.map((h) => h.padStart(COL)).join(""));
  for (const th of THRESHOLD_SWEEP) {
    const row = [`t=${th}`];
    for (const s of MARKUP_SWEEP) {
      const { totalPnl: tp, avgPnl } = runSweepPoint(windows, s, th);
      row.push(`${fmt(tp, 2)} (${fmt(avgPnl, 3)})`);
    }
    console.log("  " + row.map((c) => c.padStart(COL)).join(""));
  }
  console.log("\nCell format: total_pnl (avg_pnl_per_window)");
}

// --- round 2: SpreadPolicy + unwind ---------------------------------------

function runRound2(windows, baseSpread, aggressiveness) {
  return windows.map((w) =>
    simulateWindow({
      tradingStart: w.tradingStart,
      expiry: w.expiry,
      K: w.K,
      sigmaS: w.sigmaS,
      outcomeUp: w.outcomeUp,
      ticks: w.windowTicks,
      trades: w.trades,
      spreadPolicy: spreadPolicyConfig(baseSpread),
      unwind: { aggressiveness },
      requoteThreshold: DEFAULT_REQUOTE_THRESHOLD,
      mintSize: DEFAULT_MINT_SIZE,
      gasCost: DEFAULT_GAS_COST,
    })
  );
}

function totalPnlOf(results) {
  return results.reduce((s, r) => s + r.pnl, 0);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Diagnostic requested by the coordinator: every historical trade in the
// dataset was, in reality, executed against an incumbent maker (Keel was
// never actually resting an order on these markets -- this whole backtest
// is a replay). `tradeEvaluations` (see worker/marketmaker.js) records the
// causal fair value P in effect at the moment of every in-window trade,
// independent of whichever markup/spreadPolicy config was used to produce
// it (P is a pure function of ticks/sigma/K), so results from ANY run can
// be reused here.
function analyzeIncumbent(results, referenceMarkup) {
  const halfSpreadsUp = [];
  const halfSpreadsDown = [];
  let insideCount = 0;
  let total = 0;
  for (const r of results) {
    for (const ev of r.tradeEvaluations) {
      const halfSpread = ev.side === "UP" ? ev.price - ev.quoteP : ev.quoteP - ev.price;
      (ev.side === "UP" ? halfSpreadsUp : halfSpreadsDown).push(halfSpread);
      total++;
      if (halfSpread < referenceMarkup) insideCount++;
    }
  }
  const all = [...halfSpreadsUp, ...halfSpreadsDown];
  return {
    n: total,
    nUp: halfSpreadsUp.length,
    nDown: halfSpreadsDown.length,
    meanHalfSpread: all.length ? all.reduce((a, b) => a + b, 0) / all.length : null,
    medianHalfSpread: median(all),
    medianHalfSpreadUp: median(halfSpreadsUp),
    medianHalfSpreadDown: median(halfSpreadsDown),
    fractionInside: total ? insideCount / total : 0,
    insideCount,
  };
}

function printRound2Report(windows, round1DefaultResults) {
  console.log("\n\n============================================================");
  console.log("ROUND 2: incumbent-maker diagnostic + defenses 1-3");
  console.log("============================================================");

  const diag = analyzeIncumbent(round1DefaultResults, DEFAULT_BASE_SPREAD);
  console.log(`\n--- Incumbent-maker diagnostic (reference markup = ${DEFAULT_BASE_SPREAD}) ---`);
  console.log(`Total recorded trades evaluated: ${diag.n} (${diag.nUp} Up-buys, ${diag.nDown} Down-buys)`);
  console.log(
    `Incumbent's realized half-spread over fair value: median=${fmt(diag.medianHalfSpread, 4)} ` +
      `(Up=${fmt(diag.medianHalfSpreadUp, 4)}, Down=${fmt(diag.medianHalfSpreadDown, 4)}), mean=${fmt(diag.meanHalfSpread, 4)}`
  );
  console.log(
    `Fraction of trades at/inside fair-value+${DEFAULT_BASE_SPREAD} (i.e. priced tighter than we would ever have quoted, ` +
      `so we could never have been the resting order that filled them): ${diag.insideCount}/${diag.n} = ${fmt(diag.fractionInside * 100, 1)}%`
  );
  console.log(
    "Reading: a large fraction here means most trade flow cleared at a price an incumbent maker was already resting\n" +
      "at, tighter than our own quote -- i.e. we were quoting BEHIND an incumbent, not competing for that flow at all,\n" +
      "which is the mechanism the coordinator's diagnosis proposed for the 232/300 no-fill windows in round 1."
  );

  const round2Default = runRound2(windows, DEFAULT_BASE_SPREAD, DEFAULT_UNWIND_AGGRESSIVENESS);
  const totalRound2 = totalPnlOf(round2Default);
  const totalRound1 = totalPnlOf(round1DefaultResults);
  console.log(
    `\n--- Round 2 default run (baseSpread=${DEFAULT_BASE_SPREAD}, unwind.aggressiveness=${DEFAULT_UNWIND_AGGRESSIVENESS}, ` +
      `skewCoef=${ROUND2_SKEW_COEF}, refTau=${ROUND2_REF_TAU}, maxUrgencyMult=${ROUND2_MAX_URGENCY_MULT}) ---`
  );
  console.log(`Total PnL: ${fmt(totalRound2)}  (round-1 flat-markup default for comparison: ${fmt(totalRound1)})`);
  console.log(`PnL per window (avg): ${fmt(totalRound2 / round2Default.length)}`);

  console.log("\n--- Joint sweep: baseSpread x unwind.aggressiveness (total PnL) ---");
  const COL = 14;
  const header = ["s\\aggr", ...UNWIND_AGGRESSIVENESS_SWEEP.map((a) => `a=${a}`)];
  console.log("  " + header.map((h) => h.padStart(COL)).join(""));
  let best = { pnl: -Infinity, baseSpread: null, aggressiveness: null };
  const grid = [];
  for (const bs of BASE_SPREAD_SWEEP) {
    const row = [`s=${bs}`];
    const rowVals = [];
    for (const aggr of UNWIND_AGGRESSIVENESS_SWEEP) {
      const results = runRound2(windows, bs, aggr);
      const pnl = totalPnlOf(results);
      rowVals.push(pnl);
      if (pnl > best.pnl) best = { pnl, baseSpread: bs, aggressiveness: aggr };
      row.push(fmt(pnl, 4));
    }
    grid.push(rowVals);
    console.log("  " + row.map((c) => c.padStart(COL)).join(""));
  }

  console.log(`\nBest cell in the joint sweep: baseSpread=${best.baseSpread}, aggressiveness=${best.aggressiveness}, total PnL=${fmt(best.pnl)}`);
  if (best.pnl >= 0) {
    console.log("Break-even (or better) IS reached somewhere in this grid.");
  } else {
    console.log(
      "No combination of baseSpread and unwind.aggressiveness in this grid reaches break-even. " +
        "Stated plainly: even with all three defenses modeled, this sample does not show a profitable configuration."
    );
  }
}

// --- main ----------------------------------------------------------------

async function main() {
  console.log(`Fetching up to ${MARKET_LIMIT} finalized BINARY markets on DreamDEX venue...`);
  const markets = await fetchFinalizedMarkets(MARKET_LIMIT);
  console.log(`Got ${markets.length} settled markets. Loading tick + fill data (cached under data/cache/)...`);

  const windows = [];
  const skipped = {};
  let done = 0;
  for (const market of markets) {
    const w = await loadWindowData(market);
    if (w.skip) {
      skipped[w.skip] = (skipped[w.skip] || 0) + 1;
    } else {
      windows.push(w);
    }
    done++;
    if (done % 25 === 0) console.log(`  ...${done}/${markets.length}`);
  }

  console.log(`\nWindows usable for simulation: ${windows.length} / ${markets.length}`);
  if (Object.keys(skipped).length) console.log("Skipped:", skipped);
  if (windows.length === 0) {
    console.log("Nothing to simulate -- check skip reasons above.");
    return;
  }

  const defaultResults = windows.map((w) =>
    simulateWindow({
      tradingStart: w.tradingStart,
      expiry: w.expiry,
      K: w.K,
      sigmaS: w.sigmaS,
      outcomeUp: w.outcomeUp,
      ticks: w.windowTicks,
      trades: w.trades,
      markup: DEFAULT_MARKUP,
      requoteThreshold: DEFAULT_REQUOTE_THRESHOLD,
      mintSize: DEFAULT_MINT_SIZE,
      gasCost: DEFAULT_GAS_COST,
    })
  );

  printReport(windows, defaultResults);
  printRound2Report(windows, defaultResults);
}

main().catch((err) => {
  console.error("mmbacktest failed:", err);
  process.exit(1);
});
