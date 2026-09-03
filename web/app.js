// The Keel console. Imports the pricer and the spread policy straight out of
// `worker/` rather than reimplementing them in the browser — the same modules the
// back-test scores and `contracts/src/lib/SpreadPolicy.sol` mirrors line for line.
// If the numbers on this page were wrong, the test suite would already be red.

import { sigmaPerSecond, fairValue } from "/worker/pricer.js";
import { quote, DEFAULT_CONFIG } from "/worker/spreadPolicy.js";

const INDEXER = "https://dev.smk.somnia.host/v1/graphql";
const PRICEFEED = "https://price-feed.dev.oracle.somnia.host/v1/graphql";
const RPC = "https://dream-rpc.somnia.network";
const PRICE_SCALE = 1e18;
const PAGE = 5000;

// Function selectors, so the page can read chain state without shipping an ABI
// encoder. All no-argument views returning a single word.
const SEL = {
  seriesCount: "0xd7f2c0ef",
  creatorFloat: "0xef947cdc",
  launchCost: "0xdde91a98",
  totalAssets: "0x01e1d114",
};

let deployment = null;

async function gql(url, query, variables = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Hasura caps rows per response and a single large `limit` truncates in silence —
// it under-reported the market count by more than half once already.
async function gqlAll(url, query, variables = {}) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const data = await gql(url, query, { ...variables, limit: PAGE, offset });
    const page = Object.values(data)[0];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function ethCall(to, data) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return BigInt(json.result);
}

const el = (id) => document.getElementById(id);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const short = (a) => `${a.slice(0, 8)}…${a.slice(-4)}`;
const stt = (wei) => (Number(wei) / 1e18).toFixed(2);

function stat(k, v, small = false) {
  return `<div class="stat"><div class="k">${k}</div><div class="v${small ? " sm" : ""}">${v}</div></div>`;
}

// ---------------------------------------------------------------------------
// The live strip — what this deployment has actually done on chain
// ---------------------------------------------------------------------------

async function renderStrip() {
  if (!deployment) {
    el("strip").innerHTML = stat("status", "not deployed", true);
    return;
  }
  const { KeelFactory, KeelVault } = deployment.contracts;

  // A failed read must not blank the whole strip — each cell falls back on its own.
  const read = async (to, sel) => {
    try {
      return await ethCall(to, sel);
    } catch {
      return null;
    }
  };

  const [series, float, cost, assets, markets] = await Promise.all([
    read(KeelFactory, SEL.seriesCount),
    read(KeelFactory, SEL.creatorFloat),
    read(KeelFactory, SEL.launchCost),
    read(KeelVault, SEL.totalAssets),
    gqlAll(
      INDEXER,
      `query($venue: String!, $limit: Int!, $offset: Int!) {
        Market(where: { venueId: { _eq: $venue } }, order_by: { expiry: asc }, limit: $limit, offset: $offset) {
          finalized
        }
      }`,
      { venue: deployment.venueId },
    ).catch(() => []),
  ]);

  const settled = markets.filter((m) => m.finalized).length;

  el("strip").innerHTML = [
    stat("series live", series === null ? "—" : series.toString()),
    stat("windows minted", markets.length),
    stat("settled", settled),
    stat("creator float", float === null ? "—" : `${stt(float)}<span class="k"> STT</span>`),
    stat("launch price", cost === null ? "—" : `${stt(cost)}<span class="k"> STT</span>`),
    stat("vault assets", assets === null ? "—" : `${(Number(assets) / 1e6).toFixed(0)}<span class="k"> tUSDC</span>`),
  ].join("");
}

// ---------------------------------------------------------------------------
// Keel's own book — the markets this deployment minted
// ---------------------------------------------------------------------------

async function renderSeries() {
  if (!deployment) {
    el("series-list").className = "";
    el("series-list").innerHTML =
      `<p class="note">No deployment found. Run <code>npm run deploy -- --confirm</code>, then <code>npm run launch -- SOL 300 --confirm</code>.</p>`;
    return;
  }

  const markets = await gqlAll(
    INDEXER,
    `query($venue: String!, $limit: Int!, $offset: Int!) {
      Market(where: { venueId: { _eq: $venue } }, order_by: { expiry: desc }, limit: $limit, offset: $offset) {
        asset poolAddress tradingStart expiry finalized voided winningOutcome tradeCount
      }
    }`,
    { venue: deployment.venueId },
  );

  // How many orders the vault has resting on each pool, read from the vault itself.
  // `openOrders(address)` = 0x5808bb38, verified with `cast sig` rather than guessed —
  // a wrong selector here returns empty and the column would silently read "none".
  // It returns a uint128[]: an offset word, a length word, then the ids, so the
  // length is the second word of the result.
  const resting = new Map();
  await Promise.all(
    markets.map(async (m) => {
      try {
        const data = `0x5808bb38${m.poolAddress.slice(2).toLowerCase().padStart(64, "0")}`;
        const res = await fetch(RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to: deployment.contracts.KeelVault, data }, "latest"],
          }),
        });
        const json = await res.json();
        if (json.result && json.result.length >= 130) {
          resting.set(m.poolAddress, Number(BigInt(`0x${json.result.slice(66, 130)}`)));
        }
      } catch {
        /* a pool the vault never registered simply has none */
      }
    }),
  );

  el("series-list").className = "";
  if (markets.length === 0) {
    el("series-list").innerHTML =
      `<p class="note">The venue is live but no series has been launched yet. <code>npm run launch -- SOL 300 --confirm</code> opens one.</p>`;
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const hm = (t) => new Date(t * 1000).toISOString().slice(11, 16);

  // `winningOutcome == 0` is Up on the indexer. On-chain the getter was removed in
  // settlement v3; contracts read `payoutNumerators()` and take the argmax instead.
  const outcome = (m) => {
    if (m.voided) return '<span class="status warn">voided</span>';
    if (!m.finalized) {
      return Number(m.expiry) > now
        ? '<span class="status ok">open</span>'
        : '<span class="status idle">awaiting oracle</span>';
    }
    return m.winningOutcome === 0 ? '<span class="status ok">Up</span>' : '<span class="status ok">Down</span>';
  };

  el("series-list").innerHTML = `<div class="scroll"><table>
    <thead><tr><th>Asset</th><th>Window (UTC)</th><th>Pool</th><th>Settled</th><th class="num">Keel quotes</th><th class="num">Trades</th></tr></thead>
    <tbody>${markets
      .map(
        (m) => `<tr>
          <td class="ticker">${m.asset}</td>
          <td class="ticker">${hm(Number(m.tradingStart))}–${hm(Number(m.expiry))}</td>
          <td class="ticker">${short(m.poolAddress)}</td>
          <td>${outcome(m)}</td>
          <td class="num">${resting.get(m.poolAddress) ? `<span class="status ok">${resting.get(m.poolAddress)} resting</span>` : "&mdash;"}</td>
          <td class="num">${Number(m.tradeCount ?? 0).toLocaleString()}</td>
        </tr>`,
      )
      .join("")}</tbody></table></div>
    <p class="note">Every one of these windows was minted by Keel's own market creator, on Keel's own venue, and resolved by the Somnia oracle without anyone touching it.</p>`;
}

// ---------------------------------------------------------------------------
// Coverage: what the oracle feeds vs what has ever traded
// ---------------------------------------------------------------------------

async function renderCoverage() {
  const [{ Symbol: symbols }, markets] = await Promise.all([
    gql(PRICEFEED, `query { Symbol(where: { active: { _eq: true } }, limit: 200) { symbol } }`),
    gqlAll(
      INDEXER,
      `query($limit: Int!, $offset: Int!) {
        Market(where: { marketType: { _eq: "BINARY" } }, order_by: { id: asc }, limit: $limit, offset: $offset) {
          asset tradeCount
        }
      }`,
    ),
  ]);

  const oracleAssets = [...new Set(symbols.map((s) => s.symbol.split("/")[0]))].sort();
  const traded = new Map();
  for (const m of markets) {
    traded.set(m.asset, (traded.get(m.asset) ?? 0) + Number(m.tradeCount ?? 0));
  }
  const uncovered = oracleAssets.filter((a) => !traded.has(a));

  el("coverage-count").className = "";
  el("coverage-count").innerHTML =
    `<div class="count">${uncovered.length}<small> of ${oracleAssets.length} oracle-fed assets have no Event Contracts at all</small></div>`;

  const rows = oracleAssets
    .map((asset) => ({ asset, covered: traded.has(asset), trades: traded.get(asset) ?? 0 }))
    .sort((a, b) => Number(a.covered) - Number(b.covered) || a.asset.localeCompare(b.asset));

  el("coverage-table").innerHTML = `
    <thead><tr><th>Asset</th><th>State</th><th class="num">Trades</th><th class="num"></th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
          <td class="ticker">${r.asset}</td>
          <td>${r.covered ? '<span class="status ok">listed</span>' : '<span class="status warn">uncovered</span>'}</td>
          <td class="num">${r.trades.toLocaleString()}</td>
          <td class="num">${r.covered ? "" : `<button data-launch="${r.asset}">Plan</button>`}</td>
        </tr>`,
      )
      .join("")}</tbody>`;

  el("coverage-table").addEventListener("click", (e) => {
    const asset = e.target.dataset?.launch;
    if (asset) showLaunchPlan(asset);
  });
}

// The launch call, spelled out rather than fired. Anyone can send this; the value
// funds the creator's float, which pays each window's oracle create value, so the
// launcher buys the series a runway instead of a single market.
function showLaunchPlan(asset) {
  const factory = deployment ? deployment.contracts.KeelFactory : "0x… (deploy first)";
  el("launch-plan").innerHTML = `
    <div class="plan">$ npm run launch -- ${asset} 300 --confirm

KeelFactory.launch(                 // ${factory}
  asset            "${asset}"
  collateral       tUSDC 0x70a86D88…5d8E
  numericDecimals  8
  intervalSec      300              // 5-minute windows
  settlementWindow 300
){ value: launchCost() }

Then, every 300s and with no further input:
  the creator mints the next window
  the vault mints a complete set and rests both legs above par
</div>
    <p class="note">Permissionless. The duplicate guard keys on (asset, interval, collateral), so a second identical series reverts naming the one that already exists.</p>`;
}

// ---------------------------------------------------------------------------
// Live windows, priced with the policy the contract enforces
// ---------------------------------------------------------------------------

async function ticksFor(asset, from) {
  const { PricePoint } = await gql(
    PRICEFEED,
    `query($symbol: String!, $from: numeric!) {
      PricePoint(where: { symbol: { _eq: $symbol }, blockTimestamp: { _gte: $from } }, order_by: { blockTimestamp: asc }, limit: 5000) {
        spot blockTimestamp
      }
    }`,
    { symbol: `${asset}/USDC`, from },
  );
  return PricePoint.map((p) => ({ t: Number(p.blockTimestamp), price: Number(p.spot) / PRICE_SCALE }));
}

function loadLine(askUp, askDown, minSpread) {
  const sum = askUp + askDown;
  const markup = sum - 1;
  const floor = 2 * minSpread;
  // Fixed axis at eight times the required floor, so the bar reads as clearance
  // above the line and two windows with different markups look different. A
  // markup that fails the invariant lands short of the mark, which is the point.
  const full = Math.max(floor * 8, markup * 1.1);
  const width = Math.min(100, (markup / full) * 100);
  const markAt = Math.min(100, (floor / full) * 100);
  return `<div class="loadline">
    <div class="track"><div class="fill" style="width:${width}%"></div><div class="mark" style="left:${markAt}%"></div></div>
    <div class="cap"><span>markup ${(markup * 100).toFixed(2)}pp</span><span>required floor ${(floor * 100).toFixed(2)}pp</span></div>
  </div>`;
}

async function renderWindows() {
  const now = Math.floor(Date.now() / 1000);

  // Keel's own venue first. If nothing is open there, fall back to other venues'
  // windows purely to exercise the pricer against live data — labelled as such,
  // because Keel does not underwrite books it did not launch.
  let live = [];
  let ownBook = true;
  if (deployment) {
    ({ Market: live } = await gql(
      INDEXER,
      `query($venue: String!, $now: numeric!) {
        Market(
          where: { venueId: { _eq: $venue }, marketType: { _eq: "BINARY" }, expiry: { _gt: $now }, finalized: { _eq: false } }
          order_by: { expiry: asc }
          limit: 8
        ) { id asset intervalSec tradingStart expiry }
      }`,
      { venue: deployment.venueId, now },
    ));
  }
  if (live.length === 0) {
    ownBook = false;
    ({ Market: live } = await gql(
      INDEXER,
      `query($now: numeric!) {
        Market(
          where: { marketType: { _eq: "BINARY" }, expiry: { _gt: $now }, finalized: { _eq: false } }
          order_by: { expiry: asc }
          limit: 4
        ) { id asset intervalSec tradingStart expiry }
      }`,
      { now },
    ));
  }

  el("window-list").className = "";
  if (live.length === 0) {
    el("window-list").innerHTML =
      `<p class="note">No open windows anywhere right now. The console prices whatever is live; run it again in a minute.</p>`;
    return;
  }

  const cards = [];
  if (!ownBook) {
    cards.push(
      `<p class="note">No Keel window is open this second, so these are other venues' live windows — shown to exercise the pricer against real oracle data, not because Keel quotes them. Keel underwrites only books it launched itself.</p>`,
    );
  }

  for (const m of live) {
    const tradingStart = Number(m.tradingStart);
    const expiry = Number(m.expiry);
    const tau = expiry - Math.floor(Date.now() / 1000);
    const ticks = await ticksFor(m.asset, tradingStart - 3600);
    const causal = ticks.filter((t) => t.t < tradingStart);
    const sigmaS = causal.length >= 50 ? sigmaPerSecond(causal) : null;
    let strike = null;
    for (const t of ticks) if (t.t <= tradingStart) strike = t.price;
    const last = ticks.at(-1);
    const cls = ownBook ? "window mine" : "window";

    if (!sigmaS || !strike || !last || tau <= 0) {
      cards.push(`<div class="${cls}"><h3>${m.asset} <span class="meta">${m.intervalSec}s window</span></h3>
        <p class="note">Not priceable: ${!sigmaS ? "not enough pre-open ticks to train σ" : !strike ? "no tick at or before the open" : "window has expired"}. Keel rests nothing rather than guessing.</p></div>`);
      continue;
    }

    const fv = Math.min(0.99, Math.max(0.01, fairValue(last.price, strike, tau, sigmaS)));
    const q = quote(DEFAULT_CONFIG, fv, tau, 0, 0);

    cards.push(`<div class="${cls}">
      <h3>${m.asset} <span class="meta">${m.intervalSec}s window · ${tau}s to expiry · strike ${strike.toFixed(4)} · spot ${last.price.toFixed(4)}</span></h3>
      <div class="legs">
        <div class="leg"><div class="label">Fair value, Up</div><div class="val">${pct(fv)}</div></div>
        <div class="leg"><div class="label">Ask, Up</div><div class="val">${pct(q.askUp)}</div></div>
        <div class="leg"><div class="label">Ask, Down</div><div class="val">${pct(q.askDown)}</div></div>
      </div>
      ${loadLine(q.askUp, q.askDown, DEFAULT_CONFIG.minSpread)}
      <p class="note">σ trained on ${causal.length} ticks from before this window opened. Widening tracks √(refτ/τ), which is how fast the fair value's own sensitivity to spot is growing.</p>
    </div>`);
  }
  el("window-list").innerHTML = cards.join("");
}

async function renderDeployment() {
  if (!deployment) return;
  el("deployment").textContent =
    `Vault ${deployment.contracts.KeelVault} · factory ${deployment.contracts.KeelFactory} · venue ${deployment.venueId.slice(0, 12)}… · deployed ${deployment.deployedAt.slice(0, 10)}`;
}

// The deployment is read once, before anything else — every panel below reports on
// Keel's own venue, and reading it per panel would let them disagree.
async function boot() {
  try {
    const res = await fetch("/deployments/shannon.json");
    if (res.ok) deployment = await res.json();
  } catch {
    /* not deployed yet; each panel says so in its own words */
  }

  for (const [job, target] of [
    [renderStrip, "strip"],
    [renderSeries, "series-list"],
    [renderWindows, "window-list"],
    [renderCoverage, "coverage-count"],
    [renderDeployment, "deployment"],
  ]) {
    job().catch((err) => {
      el(target).className = "";
      el(target).innerHTML = `<p class="note">Could not reach the live endpoint: ${err.message}</p>`;
    });
  }
}

boot();
