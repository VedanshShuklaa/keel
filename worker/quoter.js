#!/usr/bin/env node
// The live quoter. Keel's markets open already quoted because this loop mints a
// complete set the moment a window opens and rests both legs of it above par.
//
// The decision half is `planWindow` — pure, no I/O, and exercised directly by
// `worker/test/quoter.test.js`. The loop below is the boring half: read chain and
// oracle, ask `planWindow` what to do, do it. Everything that could lose money
// lives in the pure half where it can be tested, and the prices themselves are not
// decided here at all — the vault recomputes them on-chain from the fair value
// this loop supplies, and rejects the pair if it does not clear par.
//
//   node worker/quoter.js            # dry run: prints the plan, sends nothing
//   DRY_RUN=false node worker/quoter.js

import { sigmaPerSecond, fairValue } from "./pricer.js";

export const DEFAULT_LIMITS = {
  // Below this, a resting quote is a bet on the last few seconds rather than a
  // spread business: fair value's sensitivity to spot goes as 1/sqrt(tau), so the
  // quote we could still cancel is already the wrong one.
  minTauSec: 20,
  // The pricer's entire input is the oracle tick. A stale tick is a confident
  // quote against a price nobody trades at any more, so it is a reason to have
  // nothing resting rather than a reason to widen.
  maxTickAgeSec: 30,
  // Cancel-and-replace costs gas and loses queue position. Only requote when the
  // model has actually moved, in probability points.
  requoteThreshold: 0.005,
  // Widening tracks sqrt(refTau/tau), so a big enough change in tau is a reason to
  // requote even when fair value has not moved at all.
  tauRequoteRatio: 0.9,
  // Hard ceiling on collateral at risk in any one window, in whole collateral units.
  maxNotionalPerWindow: 25,
  // SpreadPolicy rejects 0 and >= 1, and the region just inside those bounds is
  // where a digital's fair value is least trustworthy anyway.
  fairValueFloor: 0.01,
  fairValueCeil: 0.99,
};

/// Decide what to do about one window. Pure: same inputs, same answer, no clock
/// and no network. Returns one of
///   settle  — the window is over; finalize and redeem
///   reclaim — expired; pull the escrow back and burn what is left
///   cancel  — pull quotes and rest nothing (with a reason)
///   hold    — the resting quote is still the right one
///   quote   — replace with this fair value and size
export function planWindow({
  nowSec,
  market,
  sigmaS,
  openPrice,
  lastTick,
  inventory = { up: 0, down: 0 },
  freeCollateral = 0,
  minQuantity = 0,
  lastQuote = null,
  limits = DEFAULT_LIMITS,
}) {
  const l = { ...DEFAULT_LIMITS, ...limits };

  // `finalized` is the only settlement flag the indexer actually publishes; there
  // is no separate `resolved` field to consult.
  if (market.finalized) {
    return { action: "settle", reason: "window resolved" };
  }

  const tau = Number(market.expiry) - nowSec;
  if (tau <= 0) return { action: "reclaim", reason: "window expired" };
  if (tau < l.minTauSec) {
    return { action: "cancel", reason: `only ${tau}s left; below the ${l.minTauSec}s floor` };
  }
  if (!lastTick) return { action: "cancel", reason: "no oracle tick" };

  const tickAge = nowSec - lastTick.t;
  if (tickAge > l.maxTickAgeSec) {
    return { action: "cancel", reason: `oracle tick is ${tickAge}s old` };
  }
  if (!Number.isFinite(sigmaS) || sigmaS <= 0) {
    return { action: "cancel", reason: "no volatility estimate" };
  }
  if (!Number.isFinite(openPrice) || openPrice <= 0) {
    return { action: "cancel", reason: "no strike" };
  }

  const raw = fairValue(lastTick.price, openPrice, tau, sigmaS);
  if (!Number.isFinite(raw)) return { action: "cancel", reason: "fair value did not compute" };
  const fairValueUp = Math.min(l.fairValueCeil, Math.max(l.fairValueFloor, raw));

  // Size against what we can actually back. Sets already held count toward the
  // quote; only the shortfall needs minting, and only up to free collateral.
  const held = Math.min(inventory.up, inventory.down);
  const budget = Math.min(l.maxNotionalPerWindow, held + freeCollateral);
  const quantity = budget;
  const mint = Math.max(0, quantity - held);

  if (quantity <= 0) return { action: "cancel", reason: "no collateral free to quote with" };
  if (quantity < minQuantity) {
    return { action: "cancel", reason: `size ${quantity} is under the book minimum ${minQuantity}` };
  }

  if (lastQuote) {
    const moved = Math.abs(fairValueUp - lastQuote.fairValueUp);
    const tauRatio = tau / lastQuote.tau;
    // Size is a float derived from dividing live on-chain bigints by the token
    // unit, so two economically identical reads can differ in the last bit — dust
    // in the collateral balance is enough. An exact comparison would fail every
    // tick whenever the vault is capital-constrained (i.e. whenever `quantity` is
    // not clamped to the constant ceiling), cancelling and replacing every 15s and
    // burning exactly the gas and queue position this gate exists to protect.
    const sizeSame = Math.abs(lastQuote.quantity - quantity) <= 1e-9 * Math.max(1, quantity);
    if (moved < l.requoteThreshold && tauRatio > l.tauRequoteRatio && sizeSame) {
      return {
        action: "hold",
        reason: `fair value moved ${(moved * 100).toFixed(2)}pp, under the requote threshold`,
        fairValueUp,
        tau,
      };
    }
  }

  return { action: "quote", reason: "requote", fairValueUp, quantity, mint, tau, tickAge };
}

/// Ticks strictly before the window opened. Training on anything inside the window
/// leaks the answer into the estimate — the back-test makes the same cut.
export function trainSigma(ticks, tradingStart) {
  const causal = ticks.filter((t) => t.t < tradingStart);
  if (causal.length < 50) return null;
  return sigmaPerSecond(causal);
}

export function strikeFrom(ticks, tradingStart) {
  let chosen = null;
  for (const tick of ticks) {
    if (tick.t <= tradingStart) chosen = tick;
    else break;
  }
  return chosen ? chosen.price : null;
}

// ---------------------------------------------------------------------------
// The I/O half
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { keelVaultAbi, binaryPoolAbi, outcome6909Abi, erc20Abi } from "./abi.js";

const PRICE_SCALE = 1e18;
const ROOT = new URL("..", import.meta.url).pathname;

async function gql(url, query, variables = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`${url}: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// `Market` has no `pool` field — it is `poolAddress`. Asking for `pool` is not an
// empty result, it is a Hasura validation error, so this query is worth reading
// against the introspected schema rather than against intuition.
// Paginated, not capped. A fixed `limit` here does not error when it is too small
// — it silently drops the windows expiring latest, and an automated loop then never
// quotes, settles or reclaims them, with nothing in the log to say so. Keel's whole
// premise is running series across many uncovered assets, so the count this returns
// is expected to grow past any round number someone picks.
const PAGE = 1000;

async function liveMarkets(indexer, venueId) {
  const now = Math.floor(Date.now() / 1000);
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const data = await gql(
      indexer,
      `query($venue: String!, $now: numeric!, $limit: Int!, $offset: Int!) {
        Market(
          where: { venueId: { _eq: $venue }, marketType: { _eq: "BINARY" }, expiry: { _gt: $now } }
          order_by: { expiry: asc }
          limit: $limit
          offset: $offset
        ) { id asset poolAddress tradingStart expiry intervalSec finalized }
      }`,
      { venue: venueId, now, limit: PAGE, offset },
    );
    rows.push(...data.Market);
    if (data.Market.length < PAGE) break;
  }
  return rows.map((m) => ({
    marketId: m.id,
    asset: m.asset,
    pool: m.poolAddress,
    tradingStart: Number(m.tradingStart),
    expiry: Number(m.expiry),
    intervalSec: Number(m.intervalSec),
    finalized: m.finalized,
  }));
}

// Ordered *descending* and reversed, which decides what truncation costs us. Rows
// come at ~1.1s, so a long enough reachback can exceed the 5000-row cap. Ascending,
// the rows silently dropped would be the newest — including the one `lastTick` reads,
// so the quote would be priced off a stale spot with nothing looking wrong. Taking
// the newest first inverts that: a truncated fetch loses the oldest ticks, σ trains
// on fewer of them, and the `>= 50` floor cancels the quote rather than mispricing it.
async function ticksFor(pricefeed, symbol, fromTs) {
  const data = await gql(
    pricefeed,
    `query($symbol: String!, $from: numeric!) {
      PricePoint(
        where: { symbol: { _eq: $symbol }, blockTimestamp: { _gte: $from } }
        order_by: { blockTimestamp: desc }
        limit: 5000
      ) { spot blockTimestamp }
    }`,
    { symbol, from: fromTs },
  );
  return data.PricePoint
    .map((p) => ({ t: Number(p.blockTimestamp), price: Number(p.spot) / PRICE_SCALE }))
    .reverse();
}

function loadDotEnv() {
  const env = { ...process.env };
  const path = `${ROOT}.env`;
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

function loadDeployment() {
  const path = `${ROOT}deployments/shannon.json`;
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function loadEnv() {
  const env = loadDotEnv();
  const dep = loadDeployment();
  return {
    env,
    indexer: env.INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql",
    pricefeed: env.PRICEFEED_URL ?? "https://price-feed.dev.oracle.somnia.host/v1/graphql",
    rpcUrl: env.RPC_URL ?? "https://dream-rpc.somnia.network",
    chainId: dep?.chainId ?? 50312,
    // Precedence matters more than it looks. A generic `VENUE_ID` left in `.env`
    // from exploring DreamDEX's own venue must not outrank the venue this repo
    // actually deployed — quoting DreamDEX's book is the one thing Keel is not
    // for, and it would do it silently. Explicit `KEEL_VENUE_ID` still wins.
    venueId: env.KEEL_VENUE_ID ?? dep?.venueId ?? env.VENUE_ID,
    venueFromDeployment: !env.KEEL_VENUE_ID && !!dep?.venueId,
    strayVenueId: !env.KEEL_VENUE_ID && !!dep?.venueId && !!env.VENUE_ID
      && env.VENUE_ID.toLowerCase() !== dep.venueId.toLowerCase()
      ? env.VENUE_ID
      : null,
    vault: env.KEEL_VAULT_ADDRESS ?? dep?.contracts?.KeelVault,
    dryRun: (env.DRY_RUN ?? "true") !== "false",
    maxNotional: Number(env.MAX_NOTIONAL_PER_WINDOW ?? DEFAULT_LIMITS.maxNotionalPerWindow),
    intervalMs: Number(env.QUOTE_INTERVAL_MS ?? 15_000),
    once: process.argv.includes("--once"),
  };
}

// ---------------------------------------------------------------------------
// Chain access. Only built when the loop is armed — a dry run needs no key.
// ---------------------------------------------------------------------------

async function connect(cfg) {
  const { createPublicClient, createWalletClient, http, defineChain } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");

  const chain = defineChain({
    id: cfg.chainId,
    name: "Somnia Shannon",
    nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });

  const publicClient = createPublicClient({ chain, transport: http() });
  if (cfg.dryRun) return { publicClient, wallet: null, account: null };

  if (!cfg.env.BOT_PRIVATE_KEY) throw new Error("DRY_RUN=false needs BOT_PRIVATE_KEY in .env");
  const account = privateKeyToAccount(cfg.env.BOT_PRIVATE_KEY);
  const wallet = createWalletClient({ account, chain, transport: http() });
  return { publicClient, wallet, account };
}

/// Everything the plan needs that only the chain knows. Read as one batch per
/// window, because a plan built from two different block heights can size a quote
/// against inventory that has already been spent.
async function readChainState(chain, cfg, pool) {
  const vault = { address: cfg.vault, abi: keelVaultAbi };
  const [poolRow, decimals, vaultBalance, pendingDeposits, reserved, book] = await Promise.all([
    chain.publicClient.readContract({ ...vault, functionName: "pools", args: [pool] }),
    chain.publicClient.readContract({ address: cfg.collateral, abi: erc20Abi, functionName: "decimals" }),
    chain.publicClient.readContract({
      address: cfg.collateral,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [cfg.vault],
    }),
    chain.publicClient.readContract({ ...vault, functionName: "pendingDepositAssets" }),
    chain.publicClient.readContract({ ...vault, functionName: "reservedAssets" }),
    chain.publicClient.readContract({ address: pool, abi: binaryPoolAbi, functionName: "getOrderBookParameters" }),
  ]);

  const [marketId, upId, downId, oneCollateral, , outcome, registered] = poolRow;
  const unit = 10 ** Number(decimals);

  let inventory = { up: 0, down: 0 };
  if (registered) {
    const [up, down] = await Promise.all([
      chain.publicClient.readContract({
        address: outcome,
        abi: outcome6909Abi,
        functionName: "balanceOf",
        args: [cfg.vault, upId],
      }),
      chain.publicClient.readContract({
        address: outcome,
        abi: outcome6909Abi,
        functionName: "balanceOf",
        args: [cfg.vault, downId],
      }),
    ]);
    inventory = { up: Number(up) / unit, down: Number(down) / unit };
  }

  // Queued deposits and promised redemptions are not the vault's to trade — the
  // same subtraction `mintSets` makes on-chain, so a size that passes here passes
  // there too.
  const freeRaw = vaultBalance - pendingDeposits - reserved;
  return {
    registered,
    marketId,
    outcome,
    oneCollateral,
    decimals: Number(decimals),
    unit,
    freeCollateral: Number(freeRaw > 0n ? freeRaw : 0n) / unit,
    inventory,
    minQuantity: Number(book[1]) / unit,
  };
}

const toRaw = (x, unit) => BigInt(Math.floor(x * unit));

/// Send one transaction and insist it actually succeeded. `receipt.status` is
/// viem's *string* union; comparing it to 1 silently never matches, so every
/// failed transaction would read as a success.
async function send(chain, label, request) {
  const hash = await chain.wallet.writeContract(request);
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  return hash;
}

/// Carry out one plan. Simulated before sending, so a rejected order names its
/// own revert instead of costing gas to discover.
async function execute(chain, cfg, market, plan, state) {
  const vault = { address: cfg.vault, abi: keelVaultAbi, account: chain.account };
  const sent = [];

  async function call(functionName, args, label) {
    const { request } = await chain.publicClient.simulateContract({ ...vault, functionName, args });
    sent.push(`${label} ${await send(chain, label, request)}`);
  }

  switch (plan.action) {
    case "settle": {
      // These are two transactions, and the second can fail on its own — an RPC
      // timeout is enough. If it does, the market is still finalized on chain, the
      // next tick plans "settle" again, and re-sending `finalize` blind would
      // revert before ever reaching the redeem, stalling the window's escrow for
      // good. So ask the pool whether it still needs finalizing. `finalized` is
      // the fifteenth value of `getBinaryPoolParams`.
      const params = await chain.publicClient.readContract({
        address: market.pool,
        abi: binaryPoolAbi,
        functionName: "getBinaryPoolParams",
      });
      if (!params[14]) await call("finalize", [market.pool], "finalize");
      await call("redeemSettled", [market.pool], "redeemSettled");
      break;
    }

    case "reclaim":
      // Escrow first: the sets are still locked inside live orders until it runs.
      await call("reclaimExpired", [market.pool], "reclaimExpired");
      break;

    case "cancel": {
      const open = await chain.publicClient.readContract({
        address: cfg.vault,
        abi: keelVaultAbi,
        functionName: "openOrders",
        args: [market.pool],
      });
      if (open.length > 0) await call("cancelAll", [market.pool], "cancelAll");
      break;
    }

    case "hold":
      break;

    case "quote": {
      if (!state.registered) {
        await call("registerPool", [market.pool, market.marketId], "registerPool");
      }
      if (plan.mint > 0) {
        await call("mintSets", [market.pool, toRaw(plan.mint, state.unit)], "mintSets");
      }
      await call(
        "quote",
        [market.pool, BigInt(Math.round(plan.fairValueUp * 1e6)) * 10n ** 12n, toRaw(plan.quantity, state.unit)],
        "quote",
      );
      break;
    }

    default:
      throw new Error(`unknown action ${plan.action}`);
  }
  return sent;
}

async function tick(cfg, chain, state) {
  const markets = await liveMarkets(cfg.indexer, cfg.venueId);
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = [];

  for (const m of markets) {
    const symbol = `${m.asset}/USDC`;
    // Reach back far enough before the open to train sigma causally.
    const ticks = await ticksFor(cfg.pricefeed, symbol, m.tradingStart - 3600);

    let chainState = null;
    if (!cfg.dryRun) {
      chainState = await readChainState(chain, cfg, m.pool);
    }

    const plan = planWindow({
      nowSec,
      market: { expiry: m.expiry, finalized: m.finalized },
      sigmaS: trainSigma(ticks, m.tradingStart),
      openPrice: strikeFrom(ticks, m.tradingStart),
      lastTick: ticks.length ? ticks[ticks.length - 1] : null,
      inventory: chainState?.inventory ?? state.inventory.get(m.pool) ?? { up: 0, down: 0 },
      freeCollateral: chainState?.freeCollateral ?? state.freeCollateral,
      minQuantity: chainState?.minQuantity ?? 0,
      lastQuote: state.lastQuote.get(m.pool) ?? null,
      limits: { maxNotionalPerWindow: cfg.maxNotional },
    });

    let sent = [];
    if (!cfg.dryRun) {
      try {
        sent = await execute(chain, cfg, m, plan, chainState);
      } catch (err) {
        // One bad market must not stop the loop quoting the others, and it must
        // not be recorded as a quote that is resting when it is not.
        rows.push({ asset: m.asset, pool: m.pool, action: "error", reason: err.shortMessage ?? err.message });
        state.lastQuote.delete(m.pool);
        continue;
      }
    }

    if (plan.action === "quote") {
      state.lastQuote.set(m.pool, { fairValueUp: plan.fairValueUp, quantity: plan.quantity, tau: plan.tau });
    } else if (plan.action !== "hold") {
      state.lastQuote.delete(m.pool);
    }
    rows.push({ asset: m.asset, pool: m.pool, ...plan, sent });
  }
  return rows;
}

function render(rows, dryRun) {
  const stamp = new Date().toISOString().slice(11, 19);
  if (rows.length === 0) {
    console.log(`[${stamp}] no live windows on this venue`);
    return;
  }
  for (const r of rows) {
    const price = r.fairValueUp === undefined ? "     " : (r.fairValueUp * 100).toFixed(1).padStart(5);
    const size = r.quantity === undefined ? "" : ` size ${r.quantity}`;
    console.log(
      `[${stamp}] ${String(r.asset).padEnd(6)} ${r.action.padEnd(7)} P(Up) ${price}%${size}  ${r.reason}`,
    );
    for (const s of r.sent ?? []) console.log(`[${stamp}]          ${s}`);
  }
  if (dryRun) console.log(`[${stamp}] DRY_RUN — nothing was sent. Set DRY_RUN=false to arm.`);
}

async function main() {
  const cfg = loadEnv();
  if (!cfg.venueId) {
    console.error("Set KEEL_VENUE_ID (or VENUE_ID), or deploy first so deployments/shannon.json has one.");
    process.exit(1);
  }
  if (!cfg.dryRun && !cfg.vault) {
    console.error("DRY_RUN=false needs KEEL_VAULT_ADDRESS. Deploy first: npm run deploy -- --confirm");
    process.exit(1);
  }

  if (cfg.strayVenueId) {
    console.warn(`note: ignoring VENUE_ID=${cfg.strayVenueId} in .env — using the venue this repo deployed.`);
    console.warn("      set KEEL_VENUE_ID if you really mean to quote a different venue.");
  }
  console.log(`venue ${cfg.venueId}`);

  const chain = await connect(cfg);
  if (!cfg.dryRun) {
    cfg.collateral = await chain.publicClient.readContract({
      address: cfg.vault,
      abi: keelVaultAbi,
      functionName: "asset",
    });
    console.log(`armed — quoter ${chain.account.address}, vault ${cfg.vault}`);
  }

  const state = { inventory: new Map(), lastQuote: new Map(), freeCollateral: cfg.maxNotional };
  for (;;) {
    try {
      render(await tick(cfg, chain, state), cfg.dryRun);
    } catch (err) {
      console.error(`[error] ${err.message}`);
    }
    if (cfg.once) return;
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
