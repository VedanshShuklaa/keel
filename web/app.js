// The Keel market builder.
//
// Every command the CLI can run, as a guided sequence: connect, stand up the
// protocol, launch a market, fund the vault, quote a window, settle. Each control
// says what it does before you press it, each stage says what to do next, and every
// revert is translated into a sentence about the rule that was broken rather than a
// hex selector.
//
// The prices shown here come from `worker/pricer.js` and `worker/spreadPolicy.js`
// imported directly — the same modules the back-test scores and the Solidity library
// mirrors line for line. The interface cannot show a price the contract would reject.

import { sigmaPerSecond, fairValue } from "/worker/pricer.js";
import { quote as policyQuote, DEFAULT_CONFIG } from "/worker/spreadPolicy.js";
import {
  SHANNON, hasWallet, connect, currentAccount, currentChainId, switchToShannon,
  onWalletChange, deploy, txUrl, addressUrl, getBalance,
} from "/web/lib/chain.js";
import {
  PROTOCOL, actions, factory, vault, token, poolReads,
  fmtUnits, fmtStt, toRaw, explainError,
} from "/web/lib/keel.js";

const INDEXER = "https://dev.smk.somnia.host/v1/graphql";
const PRICEFEED = "https://price-feed.dev.oracle.somnia.host/v1/graphql";
const PRICE_SCALE = 1e18;
const PAGE = 5000;

const S = {
  account: null,
  chainId: null,
  deployment: null,
  decimals: 6,
  stage: "connect",
  roles: { owner: false, quoter: false },
  balances: { stt: null, tusdc: null },
  markets: [],
  coverage: null,
  busy: new Set(),
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

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

// Hasura caps rows per response and a single large `limit` truncates in silence.
async function gqlAll(url, query, variables = {}) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const data = await gql(url, query, { ...variables, limit: PAGE, offset });
    const page = Object.values(data)[0];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

function toast(kind, title, body, hash) {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.innerHTML = `<button class="x" aria-label="Dismiss">&times;</button>
    <div class="t">${esc(title)}</div><div>${body ?? ""}</div>
    ${hash ? `<div style="margin-top:6px"><a href="${txUrl(hash)}" target="_blank" rel="noopener">${hash.slice(0, 18)}… ↗</a></div>` : ""}`;
  node.querySelector(".x").onclick = () => node.remove();
  el("log").append(node);
  if (kind !== "err") setTimeout(() => node.remove(), 14000);
}

/// Run a chain action with the button locked, the error explained, and the page
/// refreshed afterwards. Every write goes through here, so none of them can leave a
/// spinner running or swallow a revert.
async function act(key, title, fn) {
  if (S.busy.has(key)) return;
  S.busy.add(key);
  render();
  try {
    const out = await fn();
    toast("ok", `${title} — done`, "", out?.hash);
    await refresh();
  } catch (err) {
    const message = err?.explained ?? err?.message ?? "Something went wrong.";
    // A wallet rejection is a decision, not a failure — say so plainly.
    const rejected = err?.code === 4001 || /user rejected|denied/i.test(message);
    toast(
      rejected ? "" : "err",
      rejected ? `${title} — cancelled` : `${title} — failed`,
      esc(rejected ? "You rejected the request in your wallet. Nothing was sent." : message),
      err?.hash,
    );
  } finally {
    S.busy.delete(key);
    render();
  }
}

const busyBtn = (key, label) => (S.busy.has(key) ? `<span class="spin"></span> ${esc(label)}…` : esc(label));

/// `disabled` for an action control: locked while a wallet is absent, while this
/// action is in flight, or for any extra reason the caller gives.
const lock = (key, extra = false) => (!canAct() || S.busy.has(key) || extra ? "disabled" : "");

// ---------------------------------------------------------------------------
// Loading chain and service state
// ---------------------------------------------------------------------------

async function loadDeployment() {
  try {
    const res = await fetch("/deployments/shannon.json");
    if (res.ok) return await res.json();
  } catch {
    /* no deployment yet */
  }
  return null;
}

async function refresh() {
  S.account = await currentAccount();
  S.chainId = await currentChainId();

  if (S.account) {
    S.balances.stt = await getBalance(S.account).catch(() => null);
    S.balances.tusdc = await token.balanceOf(PROTOCOL.collateral, S.account);
  }

  const d = S.deployment;
  if (d?.contracts?.KeelVault) {
    const V = d.contracts.KeelVault;
    const [owner, quoter, dec] = await Promise.all([
      vault.owner(V),
      vault.quoter(V),
      token.decimals(PROTOCOL.collateral),
    ]);
    S.decimals = dec === null ? 6 : Number(dec);
    S.roles = { owner: same(owner, S.account), quoter: same(quoter, S.account), ownerAddr: owner, quoterAddr: quoter };
    S.vaultInfo = {
      totalAssets: await vault.totalAssets(V),
      shares: S.account ? await vault.shares(V, S.account) : null,
      isFlat: await vault.isFlat(V),
      epoch: await vault.epoch(V),
      pending: S.account ? await vault.pending(V, S.account) : null,
      allowance: S.account ? await token.allowance(PROTOCOL.collateral, S.account, V) : null,
    };
  }
  if (d?.contracts?.KeelFactory) {
    const F = d.contracts.KeelFactory;
    S.factoryInfo = {
      bootstrapped: await factory.bootstrapped(F),
      seriesCount: await factory.seriesCount(F),
      float: await factory.creatorFloat(F),
      owner: await factory.owner(F),
    };
  }
  if (d?.venueId) await loadMarkets();
  render();
}

async function loadMarkets() {
  try {
    const rows = await gqlAll(
      INDEXER,
      `query($venue: String!, $limit: Int!, $offset: Int!) {
        Market(where: { venueId: { _eq: $venue } }, order_by: { expiry: desc }, limit: $limit, offset: $offset) {
          id asset poolAddress tradingStart expiry intervalSec finalized voided winningOutcome tradeCount
        }
      }`,
      { venue: S.deployment.venueId },
    );
    const V = S.deployment.contracts?.KeelVault;
    S.markets = await Promise.all(
      rows.map(async (m) => ({
        ...m,
        tradingStart: Number(m.tradingStart),
        expiry: Number(m.expiry),
        resting: V ? ((await vault.openOrders(V, m.poolAddress)) ?? []).length : 0,
      })),
    );
  } catch {
    S.markets = [];
  }
}

async function loadCoverage() {
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
  const assets = [...new Set(symbols.map((s) => s.symbol.split("/")[0]))].sort();
  const traded = new Map();
  for (const m of markets) traded.set(m.asset, (traded.get(m.asset) ?? 0) + Number(m.tradeCount ?? 0));
  S.coverage = {
    assets: assets.map((a) => ({ asset: a, covered: traded.has(a), trades: traded.get(a) ?? 0 })),
    total: assets.length,
    uncovered: assets.filter((a) => !traded.has(a)).length,
  };
}

async function ticksFor(asset, from) {
  const { PricePoint } = await gql(
    PRICEFEED,
    `query($symbol: String!, $from: numeric!) {
      PricePoint(where: { symbol: { _eq: $symbol }, blockTimestamp: { _gte: $from } }, order_by: { blockTimestamp: desc }, limit: 5000) {
        spot blockTimestamp
      }
    }`,
    { symbol: `${asset}/USDC`, from },
  );
  return PricePoint.map((p) => ({ t: Number(p.blockTimestamp), price: Number(p.spot) / PRICE_SCALE })).reverse();
}

/// Price one window exactly as the vault would: strike from the last tick at or
/// before the open, sigma trained only on ticks from before it.
async function priceWindow(m) {
  const ticks = await ticksFor(m.asset, m.tradingStart - 3600);
  const causal = ticks.filter((t) => t.t < m.tradingStart);
  const sigmaS = causal.length >= 50 ? sigmaPerSecond(causal) : null;
  let strike = null;
  for (const t of ticks) if (t.t <= m.tradingStart) strike = t.price;
  const last = ticks.at(-1);
  const tau = m.expiry - Math.floor(Date.now() / 1000);
  if (!sigmaS || !strike || !last || tau <= 0) {
    return {
      ok: false,
      tau,
      reason: !sigmaS
        ? "not enough pre-open ticks to train σ"
        : !strike
          ? "no oracle tick at or before the open"
          : "the window has expired",
    };
  }
  const fv = Math.min(0.99, Math.max(0.01, fairValue(last.price, strike, tau, sigmaS)));
  return { ok: true, fv, tau, strike, spot: last.price, ticks: causal.length, q: policyQuote(DEFAULT_CONFIG, fv, tau, 0, 0) };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

const STAGES = [
  { id: "connect", title: "Connect", sub: "Wallet and network" },
  { id: "protocol", title: "Protocol", sub: "Venue, creator, vault" },
  { id: "launch", title: "Launch a market", sub: "Open a series on an asset" },
  { id: "fund", title: "Fund the vault", sub: "Deposit, shares, epochs" },
  { id: "quote", title: "Quote a window", sub: "Rest both sides above par" },
  { id: "settle", title: "Positions", sub: "Reclaim, settle, redeem" },
];

/// A stage is browsable as soon as there is something to look at. Only the buttons
/// need a wallet — someone evaluating Keel should be able to read the whole thing
/// without installing an extension first, and locking the navigation behind a
/// connection hides the product from exactly the person you most want to show it to.
function stageAvailable(id) {
  const deployed = !!S.deployment?.contracts?.KeelVault;
  if (id === "connect" || id === "protocol") return { ok: true };
  if (!deployed) return { ok: false, why: "Stand up the protocol first — step 1." };
  return { ok: true };
}

const canAct = () => !!S.account && S.chainId === SHANNON.chainId;

/// Shown at the top of any stage whose buttons are inert, so a disabled control is
/// never a mystery.
function readOnlyBanner() {
  if (canAct()) return "";
  return `<div class="note"><b>Read-only.</b><p>You are not connected, so the buttons below are
    disabled — everything still shows live chain state and real prices.
    <button class="btn small" data-goto="connect">Connect a wallet</button> to act on it.</p></div>`;
}

function stageDone(id) {
  if (id === "connect") return !!S.account && S.chainId === SHANNON.chainId;
  if (id === "protocol") return !!S.deployment?.contracts?.KeelVault && S.factoryInfo?.bootstrapped === true;
  if (id === "launch") return (S.markets?.length ?? 0) > 0;
  if (id === "fund") return (S.vaultInfo?.totalAssets ?? 0n) > 0n;
  if (id === "quote") return !!S.markets?.some((m) => m.resting > 0);
  return false;
}

function renderRail() {
  el("rail").innerHTML =
    `<h2>Build steps</h2>` +
    STAGES.map((s, i) => {
      const avail = stageAvailable(s.id);
      const done = stageDone(s.id);
      return `<button class="steplink ${done ? "done" : ""}" data-stage="${s.id}"
        aria-current="${S.stage === s.id}" ${avail.ok ? "" : "disabled"}
        title="${esc(avail.ok ? s.sub : avail.why)}">
        <span class="num">${done ? "✓" : i}</span>
        <span><span class="t">${esc(s.title)}</span><br><span class="s">${esc(avail.ok ? s.sub : avail.why)}</span></span>
      </button>`;
    }).join("");

  for (const b of el("rail").querySelectorAll("[data-stage]")) {
    b.onclick = () => {
      S.stage = b.dataset.stage;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
  }
}

const head = (kicker, title, lede) =>
  `<div class="stage-head"><div class="stage-kicker">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${lede}</p></div>`;

const nextTo = (id, label) =>
  `<div class="next"><span class="label">Next</span>
   <button class="btn" data-goto="${id}">${esc(label)} →</button></div>`;

// ---- 0. Connect ----------------------------------------------------------

function stageConnect() {
  const wrongChain = S.account && S.chainId !== SHANNON.chainId;
  return (
    head(
      "Step 0",
      "Connect your wallet",
      `Keel runs on <b>Somnia Shannon</b>, a test network. Nothing here touches real money: gas is
       paid in test STT and markets settle in test USDC, both free from the faucet. This page never
       asks for a private key — every transaction is handed to your wallet, which shows you what
       you are signing before anything is sent.`,
    ) +
    (!hasWallet()
      ? `<div class="warn"><b>No wallet extension found.</b><p>Install MetaMask, or any injected
         wallet, and reload. Everything read-only on this console works without one — you just
         cannot send transactions.</p></div>`
      : !S.account
        ? `<div class="card"><h3>Connect</h3>
           <p class="hint">Your wallet will ask permission to share your address. Keel uses it to
           show your balances and to work out which actions you are allowed to take.</p>
           <button class="btn" data-act="connect">${busyBtn("connect", "Connect wallet")}</button></div>`
        : wrongChain
          ? `<div class="warn"><b>Wrong network.</b><p>Your wallet is on chain ${S.chainId}. Keel is
             on Shannon (chain ${SHANNON.chainId}). The button below switches it, and adds the
             network first if your wallet has not seen it before.</p>
             <button class="btn" data-act="switch">${busyBtn("switch", "Switch to Shannon")}</button></div>`
          : `<div class="ok"><b>Connected to Shannon.</b> Everything below is now unlocked.</div>
             <div class="stats">
               <div class="stat"><div class="k">Address</div><div class="v" style="font-size:14px;font-family:var(--mono)">${short(S.account)}</div></div>
               <div class="stat"><div class="k">Gas balance</div><div class="v">${fmtStt(S.balances.stt)}<small> STT</small></div></div>
               <div class="stat"><div class="k">Collateral</div><div class="v">${fmtUnits(S.balances.tusdc, S.decimals)}<small> tUSDC</small></div></div>
             </div>
             ${(S.balances.stt ?? 0n) < 10n ** 18n
               ? `<div class="warn"><b>Low on gas.</b><p>Under 1 STT. Launching a 5-minute market
                  costs about 18 STT, and a first deployment about 40. Claim test STT and tUSDC at
                  <a href="https://testnet.somnia.network" target="_blank" rel="noopener">testnet.somnia.network</a>.</p></div>`
               : ""}
             ${nextTo("protocol", "Check the protocol")}`)
  );
}

// ---- 1. Protocol ---------------------------------------------------------

function stageProtocol() {
  const d = S.deployment;
  const f = S.factoryInfo;
  const lede = `Keel cannot list markets on DreamDEX's venue — that venue gates market creation
    behind an allowlist DreamDEX owns. So Keel runs <b>its own</b> operator, venue, market creator
    and allowlist. This step either points the console at an existing deployment or stands a fresh
    one up.`;

  if (!d?.contracts?.KeelFactory) {
    return (
      head("Step 1", "Stand up the protocol", lede) +
      readOnlyBanner() +
      `<div class="card"><h3>Deploy a new Keel</h3>
        <p class="hint">Three transactions, in this order and for this reason:</p>
        <div class="preview"><span class="k">1.</span> KeelFactory       — Keel's control plane
<span class="k">2.</span> factory.bootstrap — operator, venue, market creator, allowlist
<span class="k">3.</span> KeelVault         — the underwriter, bound to that venue</div>
        <div class="warn"><b>Bootstrap runs once and cannot be repeated.</b><p>It registers an
        operator and mints a venue. If it half-runs, the venue reads as live and refuses every
        roll, and the operator it orphaned is not recoverable — you pay to do it again. That is
        why all four pieces are one transaction rather than four.</p></div>
        <div class="note"><b>Budget about 40 STT.</b><p>Deployment gas is small. The cost is the
        market creator's reactivity bond — every working creator on chain holds 32–45 STT, and
        without it the roll loop cannot arm.</p></div>
        <button class="btn" data-act="deploy" ${lock("deploy")}>${busyBtn("deploy", "Deploy Keel")}</button>
        <p class="hint" style="margin-top:10px">Prefer the terminal?
        <code>npm run deploy -- --confirm</code> does the same and writes
        <code>deployments/shannon.json</code>, which this page reads on load.</p>
      </div>`
    );
  }

  return (
    head("Step 1", "The protocol", lede) +
    readOnlyBanner() +
    `<div class="stats">
      <div class="stat"><div class="k">Bootstrapped</div><div class="v">${f?.bootstrapped ? "Yes" : "No"}</div></div>
      <div class="stat"><div class="k">Series live</div><div class="v">${f?.seriesCount ?? "—"}</div></div>
      <div class="stat"><div class="k">Creator float</div><div class="v">${fmtStt(f?.float)}<small> STT</small></div></div>
      <div class="stat"><div class="k">Vault holds</div><div class="v">${fmtUnits(S.vaultInfo?.totalAssets, S.decimals, 0)}<small> tUSDC</small></div></div>
    </div>

    <div class="card"><h3>Addresses</h3>
      <p class="hint">All of this was created by the deployment. The venue and the market creator
      are Keel's own — that is what makes permissionless listing possible at all.</p>
      <div class="scroll"><table><tbody>
        ${[
          ["Factory", d.contracts.KeelFactory],
          ["Vault", d.contracts.KeelVault],
          ["Market creator", d.contracts.marketCreator],
          ["Collateral (tUSDC)", PROTOCOL.collateral],
        ]
          .filter(([, a]) => a)
          .map(
            ([k, a]) => `<tr><td>${k}</td><td class="mono">${esc(a)}</td>
            <td class="num"><a href="${addressUrl(a)}" target="_blank" rel="noopener">explorer ↗</a></td></tr>`,
          )
          .join("")}
        <tr><td>Venue id</td><td class="mono" colspan="2">${esc(d.venueId ?? "—")}</td></tr>
      </tbody></table></div>
    </div>

    <div class="card"><h3>What this wallet can do</h3>
      <p class="hint">Different actions need different keys. Anything marked “anyone” is
      deliberately permissionless — the protocol must not depend on its operator being around.</p>
      <div class="scroll"><table>
        <thead><tr><th>Role</th><th>Address</th><th>You?</th><th>Can</th></tr></thead>
        <tbody>
          <tr><td>Factory owner</td><td class="mono">${short(f?.owner)}</td>
            <td>${same(f?.owner, S.account) ? '<span class="chip ok">yes</span>' : '<span class="chip idle">no</span>'}</td>
            <td>Set fees and reactivity gas params</td></tr>
          <tr><td>Vault owner</td><td class="mono">${short(S.roles.ownerAddr)}</td>
            <td>${S.roles.owner ? '<span class="chip ok">yes</span>' : '<span class="chip idle">no</span>'}</td>
            <td>Point the vault at a quoter. <b>Cannot withdraw — no such function exists.</b></td></tr>
          <tr><td>Quoter</td><td class="mono">${short(S.roles.quoterAddr)}</td>
            <td>${S.roles.quoter ? '<span class="chip ok">yes</span>' : '<span class="chip idle">no</span>'}</td>
            <td>Register markets, mint sets, place and cancel quotes</td></tr>
          <tr><td>Anyone</td><td class="mono">—</td><td><span class="chip ok">yes</span></td>
            <td>Launch a market, refuel, reclaim, settle, redeem, roll the epoch</td></tr>
        </tbody>
      </table></div>
    </div>

    <div class="card"><h3>Top up the market creator</h3>
      <p class="hint">Each window costs the creator roughly 1.3 STT in oracle fees. When the float
      runs out, every series it runs stalls — so refuelling is <b>permissionless</b>: anyone holding
      positions in a starving series can fix it without waiting for the operator.</p>
      <div class="inline">
        <input id="refuel-amt" type="number" min="0" step="0.1" value="5" style="max-width:150px">
        <span class="muted">STT</span>
        <button class="btn ghost" data-act="refuel" ${lock("refuel")}>${busyBtn("refuel", "Refuel")}</button>
      </div>
    </div>
    ${nextTo("launch", "Launch a market")}`
  );
}

// ---- 2. Launch -----------------------------------------------------------

function stageLaunch() {
  const cov = S.coverage;
  return (
    head(
      "Step 2",
      "Launch a market",
      `Pick an asset the Somnia oracle prices and open a rolling series on it. After the first
       window, Somnia's reactivity engine mints the next one every interval — <b>no keeper, no
       cron, nobody online</b>. This is the step that makes a market exist where none did.`,
    ) +
    readOnlyBanner() +
    `<div class="card"><h3>Where the gap is</h3>
      <p class="hint">Every asset the oracle publishes a price for, against the ones that have ever
      traded an Event Contract. An uncovered asset has a live price feed and nothing built on it.</p>
      <div id="coverage">${
        cov
          ? `<div class="stats">
               <div class="stat"><div class="k">Oracle assets</div><div class="v">${cov.total}</div></div>
               <div class="stat"><div class="k">Uncovered</div><div class="v">${cov.uncovered}</div></div>
               <div class="stat"><div class="k">Already listed</div><div class="v">${cov.total - cov.uncovered}</div></div>
             </div>
             <div class="scroll" style="max-height:290px;overflow-y:auto"><table>
               <thead><tr><th>Asset</th><th>State</th><th class="num">Trades</th><th class="num"></th></tr></thead>
               <tbody>${cov.assets
                 .map(
                   (r) => `<tr>
                 <td class="ticker">${esc(r.asset)}</td>
                 <td>${r.covered ? '<span class="chip idle">listed</span>' : '<span class="chip warn">uncovered</span>'}</td>
                 <td class="num">${r.trades.toLocaleString()}</td>
                 <td class="num"><button class="btn small ghost" data-pick="${esc(r.asset)}">Use</button></td>
               </tr>`,
                 )
                 .join("")}</tbody></table></div>`
          : `<p class="loading"><span class="spin"></span> measuring the coverage gap…</p>`
      }</div>
    </div>

    <div class="card"><h3>New series</h3>
      <div class="field">
        <label for="lx-asset">Asset ticker</label>
        <p class="why">The oracle's base symbol — <code>SOL</code>, not <code>SOL/USDC</code>.
        Uppercase letters and digits only, up to 16 characters. The contract rejects anything else,
        because a malformed ticker registers a series that mints windows and never resolves one.</p>
        <input id="lx-asset" value="SOL" maxlength="16" autocomplete="off" spellcheck="false">
      </div>
      <div class="row">
        <div class="field">
          <label for="lx-interval">Window length</label>
          <p class="why">How long each market runs before it settles. Shorter windows roll more
          often, so they cost more to launch — they consume the shared creator float faster.</p>
          <select id="lx-interval">
            <option value="300" selected>5 minutes — the usual demo cadence</option>
            <option value="60">1 minute — the fastest allowed</option>
            <option value="900">15 minutes</option>
            <option value="3600">1 hour</option>
            <option value="86400">1 day</option>
          </select>
        </div>
        <div class="field">
          <label for="lx-settle">Settlement window (seconds)</label>
          <p class="why">How long the oracle has after expiry to answer. Too short and a live
          answer arrives to a market that has already voided. 300 is safe.</p>
          <input id="lx-settle" type="number" min="60" step="60" value="300">
        </div>
      </div>
      <div id="lx-quote" class="preview">Choose an asset and cadence to see what it costs.</div>
      <div class="note"><b>What the money buys.</b><p>The value you attach goes into the market
      creator's float, which pays the oracle for every window it mints. So a launch buys the series
      a <i>runway</i>, not a single market — and anyone can extend it later with Refuel.</p></div>
      <button class="btn" data-act="launch" ${lock("launch")}>${busyBtn("launch", "Launch this market")}</button>
      <p class="hint" style="margin-top:10px">Equivalent CLI:
      <code>npm run launch -- <span id="lx-cli">SOL 300</span> --confirm</code></p>
    </div>
    ${nextTo("fund", "Fund the vault")}`
  );
}

// ---- 3. Fund -------------------------------------------------------------

function stageFund() {
  const v = S.vaultInfo ?? {};
  const [pEpoch, pAssets, pShares] = v.pending ?? [null, null, null];
  const hasPending = (pAssets ?? 0n) > 0n || (pShares ?? 0n) > 0n;
  const matured = hasPending && v.epoch !== null && pEpoch !== null && BigInt(v.epoch) > BigInt(pEpoch);

  return (
    head(
      "Step 3",
      "Fund the vault",
      `The vault is what makes a market open <i>already quoted</i>. You deposit collateral; it mints
       complete sets and rests both sides of the book. Deposits do not price instantly — they queue,
       and settle at the price struck the next time the vault is completely flat.`,
    ) +
    readOnlyBanner() +
    `<div class="stats">
      <div class="stat"><div class="k">Vault holds</div><div class="v">${fmtUnits(v.totalAssets, S.decimals, 0)}<small> tUSDC</small></div></div>
      <div class="stat"><div class="k">Your shares</div><div class="v">${fmtUnits(v.shares, S.decimals, 2)}</div></div>
      <div class="stat"><div class="k">Epoch</div><div class="v">${v.epoch ?? "—"}</div></div>
      <div class="stat"><div class="k">Flat?</div><div class="v">${v.isFlat === null || v.isFlat === undefined ? "—" : v.isFlat ? "Yes" : "No"}</div></div>
      <div class="stat"><div class="k">Your wallet</div><div class="v">${fmtUnits(S.balances.tusdc, S.decimals, 0)}<small> tUSDC</small></div></div>
    </div>

    <div class="note"><b>Why deposits queue.</b><p>Pricing a share means valuing the vault, and
    valuing it mid-window would mean marking a half-filled order book. Anything markable is
    gameable — so there is nothing to mark. The price is struck only when every order is dead and
    every position redeemed, at which point the vault's worth is simply its collateral balance.</p></div>

    <div class="card"><h3>1 — Deposit</h3>
      <p class="hint">Two transactions the first time: one approving the vault to move your tUSDC,
      one queueing the deposit. Your collateral is not traded until it has been priced into shares.</p>
      <div class="field">
        <label for="dp-amt">Amount (tUSDC)</label>
        <p class="why">Minimum 0.001. Need some? The faucet at
        <a href="https://testnet.somnia.network" target="_blank" rel="noopener">testnet.somnia.network</a>
        issues test tUSDC alongside gas.</p>
        <div class="inline">
          <input id="dp-amt" type="number" min="0" step="1" value="100" style="max-width:180px">
          <button class="btn ghost small" data-act="max-deposit" ${lock("max-deposit")}>Use my whole balance</button>
        </div>
      </div>
      <div class="inline">
        <button class="btn ghost" data-act="approve" ${lock("approve")}>${busyBtn("approve", "1. Approve")}</button>
        <button class="btn" data-act="deposit" ${lock("deposit")}>${busyBtn("deposit", "2. Queue deposit")}</button>
      </div>
      <p class="hint" style="margin-top:8px">Approved so far:
      <b>${fmtUnits(v.allowance, S.decimals, 2)} tUSDC</b>. If that already covers your amount, skip
      straight to queueing.</p>
    </div>

    <div class="card"><h3>2 — Strike the price</h3>
      <p class="hint">Rolling the epoch prices every queued deposit and redemption at once. It is
      <b>permissionless</b> — anyone can call it — but only succeeds while the vault is flat.</p>
      ${
        v.isFlat === false
          ? `<div class="warn"><b>The vault is not flat.</b><p>It still holds open orders or
             positions, so a price struck now would have to mark them. Cancel quotes, reclaim
             expired escrow and redeem settled positions in <b>Positions</b> first.</p></div>`
          : `<div class="ok">The vault is flat — the epoch can be rolled.</div>`
      }
      <button class="btn" data-act="roll" ${lock("roll", v.isFlat === false)}>${busyBtn("roll", "Roll the epoch")}</button>
    </div>

    <div class="card"><h3>3 — Claim</h3>
      <p class="hint">Once your epoch has rolled, your shares — or your collateral, if you
      redeemed — are waiting. Claiming moves them to your wallet.</p>
      ${
        hasPending
          ? matured
            ? `<div class="ok"><b>Ready to claim.</b><p>${
                (pAssets ?? 0n) > 0n
                  ? `${fmtUnits(pAssets, S.decimals)} tUSDC deposited in epoch ${pEpoch}, now priced.`
                  : `${fmtUnits(pShares, S.decimals)} shares queued for redemption in epoch ${pEpoch}.`
              }</p></div>`
            : `<div class="note"><b>Queued for epoch ${pEpoch}.</b><p>The vault is on epoch ${v.epoch}.
               Roll it once it is flat, then come back and claim.</p></div>`
          : `<p class="muted">Nothing queued on this wallet.</p>`
      }
      <button class="btn" data-act="claim" ${lock("claim", !matured)}>${busyBtn("claim", "Claim")}</button>
    </div>

    <div class="card"><h3>Withdraw</h3>
      <p class="hint">Redemption queues the same way: request now, priced at the next roll, then
      claim. Every step of the exit is permissionless — if the operator vanished tomorrow you could
      still complete it alone.</p>
      <div class="inline">
        <input id="rd-amt" type="number" min="0" step="1" placeholder="shares" style="max-width:180px">
        <button class="btn ghost" data-act="redeem" ${lock("redeem")}>${busyBtn("redeem", "Request redemption")}</button>
      </div>
    </div>
    ${nextTo("quote", "Quote a window")}`
  );
}

// ---- 4. Quote ------------------------------------------------------------

function stageQuote() {
  const now = Math.floor(Date.now() / 1000);
  const open = S.markets.filter((m) => m.expiry > now && !m.finalized);

  return (
    head(
      "Step 4",
      "Quote a window",
      `This is the actual product: turning idle collateral into a two-sided market. The vault mints
       a complete set — one unit of collateral becomes one Up <i>and</i> one Down — then sells both
       for more than the pair cost. Do that and the outcome cannot touch you.`,
    ) +
    readOnlyBanner() +
    `<div class="note"><b>The rule the contract enforces on every quote.</b>
      <p>One Up plus one Down is worth exactly one unit, whatever happens. So if both legs sell for
      more than one unit combined, the window's outcome is irrelevant to the vault:</p>
      <div class="preview" style="margin:8px 0 0"><b>askUp + askDown ≥ 1 + 2 × minSpread</b></div>
      <p style="margin-top:8px">You supply a fair value; <b>the contract computes both prices
      itself</b> and refuses the pair if it falls below that line — including after the prices are
      snapped to the exchange's tick grid, which is exactly where a markup quietly disappears.</p></div>

    ${
      canAct() && !S.roles.quoter
        ? `<div class="warn"><b>This wallet is not the vault's quoter.</b>
           <p>The quoter is <span class="mono">${short(S.roles.quoterAddr)}</span>. Only that key can
           register markets, mint sets and place quotes. Connect it to quote from here, or run the
           loop headlessly with <code>DRY_RUN=false npm run quote</code>. Everything below still
           shows exactly what it would do.</p></div>`
        : ""
    }

    ${
      canAct()
        ? ""
        : `<div class="note"><b>Who can quote.</b><p>Placing a quote needs the vault's quoter key,
           currently <span class="mono">${short(S.roles.quoterAddr)}</span>. The windows below are
           priced live either way, so you can see exactly what it would rest.</p></div>`
    }

    <div class="card"><h3>Open windows on Keel's venue</h3>
      <p class="hint">Priced by the same modules the vault mirrors on-chain, so what you see is what
      the contract would accept.</p>
      <div id="windows">${
        open.length === 0
          ? `<p class="muted">No window is open right now. Windows are short — launch a series in
             step 2, or wait for the roll loop to mint the next one.</p>`
          : `<p class="loading"><span class="spin"></span> pricing ${open.length} window${open.length > 1 ? "s" : ""}…</p>`
      }</div>
    </div>
    ${nextTo("settle", "Manage positions")}`
  );
}

/// Windows are priced after the stage paints, because each costs a round trip to the
/// price feed and blocking the whole page on that would be worse.
async function paintWindows() {
  const host = el("windows");
  if (!host) return;
  const now = Math.floor(Date.now() / 1000);
  const open = S.markets.filter((m) => m.expiry > now && !m.finalized);
  if (!open.length) return;

  const V = S.deployment?.contracts?.KeelVault;
  const free = S.vaultInfo?.totalAssets ?? 0n;
  const cards = [];

  for (const m of open) {
    const p = await priceWindow(m);
    if (!p.ok) {
      cards.push(`<div class="card"><h3>${esc(m.asset)} <span class="chip idle">${p.tau}s left</span></h3>
        <p class="hint">Not priceable: ${esc(p.reason)}. Keel rests nothing rather than guessing —
        a quote built on a stale tick is a confident price for a market nobody trades at any
        more.</p></div>`);
      continue;
    }
    const row = V ? await vault.poolRow(V, m.poolAddress) : null;
    const registered = row ? row[6] : false;
    const markup = p.q.askUp + p.q.askDown - 1;
    const floor = 2 * DEFAULT_CONFIG.minSpread;
    const full = Math.max(floor * 8, markup * 1.1);

    cards.push(`<div class="card">
      <h3>${esc(m.asset)} <span class="chip live">${p.tau}s to expiry</span>
        ${m.resting ? `<span class="chip ok">${m.resting} resting</span>` : ""}</h3>
      <p class="hint">Strike ${p.strike.toFixed(4)} · spot ${p.spot.toFixed(4)} · σ trained on
      ${p.ticks} ticks from before this window opened</p>
      <div class="legs">
        <div class="leg"><div class="l">Fair value, Up</div><div class="v">${pct(p.fv)}</div></div>
        <div class="leg"><div class="l">Ask, Up</div><div class="v">${pct(p.q.askUp)}</div></div>
        <div class="leg"><div class="l">Ask, Down</div><div class="v">${pct(p.q.askDown)}</div></div>
      </div>
      <div class="loadline">
        <div class="track"><div class="fill" style="width:${Math.min(100, (markup / full) * 100)}%"></div>
          <div class="mark" style="left:${Math.min(100, (floor / full) * 100)}%"></div></div>
        <div class="cap"><span>markup ${(markup * 100).toFixed(2)}pp</span>
          <span>required floor ${(floor * 100).toFixed(2)}pp</span></div>
      </div>
      <div class="field" style="margin-top:14px">
        <label for="q-size-${m.poolAddress}">Size on each side (tUSDC)</label>
        <p class="why">The vault mints this many complete sets, so it is the most it can have at
        risk in this window. It cannot exceed the vault's free collateral, currently
        ${fmtUnits(free, S.decimals, 0)} tUSDC.</p>
        <input id="q-size-${m.poolAddress}" type="number" min="0" step="1" value="25" style="max-width:180px">
      </div>
      <div class="inline">
        <button class="btn" data-quote="${m.poolAddress}" data-market="${m.id}" data-fv="${p.fv}"
          ${lock(`quote-${m.poolAddress}`, !S.roles.quoter)}>${busyBtn(`quote-${m.poolAddress}`, registered ? "Mint sets and quote" : "Register, mint and quote")}</button>
        ${m.resting ? `<button class="btn ghost" data-cancel="${m.poolAddress}" ${lock(`cancel-${m.poolAddress}`, !S.roles.quoter)}>${busyBtn(`cancel-${m.poolAddress}`, "Cancel quotes")}</button>` : ""}
      </div>
      ${
        registered
          ? ""
          : `<p class="hint" style="margin-top:8px">First time on this market, so the vault registers
             it too. Registration is checked against the module — the vault only ever approves a
             pool the protocol itself vouches for.</p>`
      }
    </div>`);
  }
  host.innerHTML = cards.join("");
  wireStage();
}

// ---- 5. Positions --------------------------------------------------------

function stageSettle() {
  const now = Math.floor(Date.now() / 1000);
  const hm = (t) => new Date(t * 1000).toISOString().slice(11, 16);

  return (
    head(
      "Step 5",
      "Positions and settlement",
      `What the vault is holding, and how to wind it down. Every action here is
       <b>permissionless</b> — anyone can call them, not just the operator. That is deliberate: if
       the quoter went dark mid-window, a depositor could still complete the whole exit alone.`,
    ) +
    readOnlyBanner() +
    `<div class="card"><h3>The wind-down, in order</h3>
      <p class="hint">Each step only becomes possible once the one before it has happened.</p>
      <div class="preview"><span class="k">1.</span> Cancel      pull live quotes off the book         <span class="k">(quoter)</span>
<span class="k">2.</span> Reclaim     pull escrow back from expired orders   <span class="k">(anyone, after expiry)</span>
<span class="k">3.</span> Finalize    sweep the resolved market's backing    <span class="k">(anyone, once resolved)</span>
<span class="k">4.</span> Redeem      turn the winning leg into collateral   <span class="k">(anyone)</span>
<span class="k">5.</span> Roll epoch  strike the share price                 <span class="k">(anyone, once flat)</span></div>
    </div>

    <div class="card"><h3>Markets on this venue</h3>
      ${
        S.markets.length === 0
          ? `<p class="muted">No markets yet. Launch one in step 2.</p>`
          : `<div class="scroll"><table>
              <thead><tr><th>Asset</th><th>Window (UTC)</th><th>State</th><th class="num">Keel quotes</th><th class="num">Actions</th></tr></thead>
              <tbody>${S.markets
                .map((m) => {
                  const live = m.expiry > now;
                  const state = m.voided
                    ? '<span class="chip warn">voided</span>'
                    : m.finalized
                      ? `<span class="chip ok">settled ${m.winningOutcome === 0 ? "Up" : "Down"}</span>`
                      : live
                        ? '<span class="chip live">open</span>'
                        : '<span class="chip idle">awaiting oracle</span>';
                  return `<tr>
                    <td class="ticker">${esc(m.asset)}</td>
                    <td class="mono">${hm(m.tradingStart)}–${hm(m.expiry)}</td>
                    <td>${state}</td>
                    <td class="num">${m.resting ? `<span class="chip ok">${m.resting}</span>` : "—"}</td>
                    <td class="num"><span class="inline" style="justify-content:flex-end">
                      ${!live && m.resting ? `<button class="btn small ghost" data-reclaim="${m.poolAddress}" ${lock(`reclaim-${m.poolAddress}`)}>${busyBtn(`reclaim-${m.poolAddress}`, "Reclaim")}</button>` : ""}
                      ${!live ? `<button class="btn small ghost" data-settle="${m.poolAddress}" ${lock(`settle-${m.poolAddress}`)}>${busyBtn(`settle-${m.poolAddress}`, "Settle")}</button>` : ""}
                    </span></td></tr>`;
                })
                .join("")}</tbody></table></div>`
      }
      <div class="note" style="margin-top:14px"><b>Settle</b> runs finalize and redeem together and
      skips finalize when the market has already been finalized — so pressing it twice is safe.</div>
    </div>

    <div class="card"><h3>Roll the epoch</h3>
      <p class="hint">Once the vault is flat, rolling strikes the share price and settles every
      queued deposit and redemption.</p>
      ${
        S.vaultInfo?.isFlat
          ? `<div class="ok">The vault is flat and ready to roll.</div>`
          : `<div class="warn">Not flat yet — clear the positions above first.</div>`
      }
      <button class="btn" data-act="roll" ${lock("roll", !S.vaultInfo?.isFlat)}>${busyBtn("roll", "Roll the epoch")}</button>
    </div>`
  );
}

// ---------------------------------------------------------------------------
// Render and wiring
// ---------------------------------------------------------------------------

function renderWallet() {
  const box = el("walletbox");
  if (!hasWallet()) {
    box.innerHTML = `<span class="muted">no wallet extension</span>`;
    return;
  }
  if (!S.account) {
    box.innerHTML = `<button class="btn small" data-act="connect">${busyBtn("connect", "Connect wallet")}</button>`;
  } else if (S.chainId !== SHANNON.chainId) {
    box.innerHTML = `<span class="chip warn">wrong network</span>
      <button class="btn small" data-act="switch">${busyBtn("switch", "Switch to Shannon")}</button>`;
  } else {
    box.innerHTML = `<span class="chip ok">Shannon</span>
      <span class="addr">${short(S.account)}</span>
      <span class="muted">${fmtStt(S.balances.stt)} STT · ${fmtUnits(S.balances.tusdc, S.decimals, 0)} tUSDC</span>`;
  }
  wireGlobal(box);
}

const STAGE_RENDER = {
  connect: stageConnect,
  protocol: stageProtocol,
  launch: stageLaunch,
  fund: stageFund,
  quote: stageQuote,
  settle: stageSettle,
};

function render() {
  renderWallet();
  if (!stageAvailable(S.stage).ok) S.stage = "connect";
  renderRail();
  el("stages").innerHTML = `<section class="stage on">${STAGE_RENDER[S.stage]()}</section>`;
  wireStage();
  if (S.stage === "launch") {
    updateLaunchQuote();
    if (!S.coverage) loadCoverage().then(render).catch(() => {});
  }
  if (S.stage === "quote") paintWindows().catch(() => {});
}

function wireGlobal(root) {
  for (const b of root.querySelectorAll("[data-act]")) b.onclick = () => handle(b.dataset.act);
}

function wireStage() {
  const root = el("stages");
  wireGlobal(root);
  for (const b of root.querySelectorAll("[data-goto]")) {
    b.onclick = () => {
      S.stage = b.dataset.goto;
      render();
      window.scrollTo({ top: 0 });
    };
  }
  for (const b of root.querySelectorAll("[data-pick]")) {
    b.onclick = () => {
      el("lx-asset").value = b.dataset.pick;
      updateLaunchQuote();
    };
  }
  for (const b of root.querySelectorAll("[data-quote]")) {
    b.onclick = () => doQuote(b.dataset.quote, b.dataset.market, Number(b.dataset.fv));
  }
  for (const b of root.querySelectorAll("[data-cancel]")) b.onclick = () => doCancel(b.dataset.cancel);
  for (const b of root.querySelectorAll("[data-reclaim]")) b.onclick = () => doReclaim(b.dataset.reclaim);
  for (const b of root.querySelectorAll("[data-settle]")) b.onclick = () => doSettle(b.dataset.settle);
  for (const id of ["lx-asset", "lx-interval", "lx-settle"]) {
    const node = el(id);
    if (node) node.oninput = updateLaunchQuote;
  }
}

async function updateLaunchQuote() {
  const box = el("lx-quote");
  if (!box) return;
  const asset = (el("lx-asset")?.value ?? "").toUpperCase();
  const interval = Number(el("lx-interval")?.value ?? 300);
  const cli = el("lx-cli");
  if (cli) cli.textContent = `${asset} ${interval}`;

  if (!/^[A-Z0-9]{1,16}$/.test(asset)) {
    box.innerHTML = `<span style="color:var(--signal)">“${esc(asset)}” is not a valid ticker.</span>
Uppercase letters and digits only, 1–16 characters.`;
    return;
  }
  const F = S.deployment?.contracts?.KeelFactory;
  if (!F) {
    box.textContent = "Deploy the protocol first — step 1.";
    return;
  }
  try {
    const cost = await factory.launchCostFor(F, interval);
    const perHour = Math.max(1, Math.floor(3600 / interval));
    box.innerHTML = `<span class="k">asset</span>          ${esc(asset)}
<span class="k">window</span>         every ${interval}s (${perHour} per hour)
<span class="k">collateral</span>     tUSDC
<span class="k">cost</span>           <b>${fmtStt(cost)} STT</b> → into the creator's float
<span class="k">first window</span>   minted immediately, then every ${interval}s unattended`;
  } catch {
    box.textContent = "Could not read the launch price from the factory.";
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function handle(what) {
  const d = S.deployment ?? {};
  const F = d.contracts?.KeelFactory;
  const V = d.contracts?.KeelVault;

  if (what === "connect") return act("connect", "Connect", async () => { await connect(); });
  if (what === "switch") return act("switch", "Switch network", async () => { await switchToShannon(); });

  if (what === "refuel") {
    const amt = Number(el("refuel-amt").value);
    return act("refuel", `Refuel ${amt} STT`, () => actions.refuel(S.account, F, BigInt(Math.round(amt * 1e18))));
  }

  if (what === "max-deposit") {
    el("dp-amt").value = Number(S.balances.tusdc ?? 0n) / 10 ** S.decimals;
    return undefined;
  }

  if (what === "approve") {
    const amt = toRaw(el("dp-amt").value, S.decimals);
    return act("approve", "Approve", () => actions.approve(S.account, PROTOCOL.collateral, V, amt));
  }
  if (what === "deposit") {
    const amt = toRaw(el("dp-amt").value, S.decimals);
    return act("deposit", "Queue deposit", () => actions.requestDeposit(S.account, V, amt));
  }
  if (what === "redeem") {
    const amt = toRaw(el("rd-amt").value, S.decimals);
    return act("redeem", "Request redemption", () => actions.requestRedeem(S.account, V, amt));
  }
  if (what === "claim") return act("claim", "Claim", () => actions.claim(S.account, V));
  if (what === "roll") return act("roll", "Roll epoch", () => actions.rollEpoch(S.account, V));

  if (what === "launch") {
    const asset = el("lx-asset").value.toUpperCase();
    const intervalSec = Number(el("lx-interval").value);
    const settlementWindow = Number(el("lx-settle").value);
    return act("launch", `Launch ${asset}`, async () => {
      const value = await factory.launchCostFor(F, intervalSec);
      return actions.launch(S.account, F, {
        asset,
        collateral: PROTOCOL.collateral,
        numericDecimals: 8,
        intervalSec,
        settlementWindow,
        value,
      });
    });
  }

  if (what === "deploy") return doDeploy();
  return undefined;
}

// Mirrors worker/spreadPolicy.js DEFAULT_CONFIG, which is itself tested against the
// Solidity library's own reference values.
const SPREAD_CONFIG = [
  15000000000000000n, 5000000000000000n, 80000000000000000n, 900n, 500000000000000000n, 6000000000000000000n,
];
const BOOK = [1000n, 1000n, 1000n];

function doDeploy() {
  return act("deploy", "Deploy Keel", async () => {
    const load = async (name) => {
      const res = await fetch(`/contracts/out/${name}.sol/${name}.json`);
      if (!res.ok) throw new Error(`No build artifact for ${name}. Run \`forge build --root contracts\` first.`);
      return (await res.json()).bytecode.object;
    };
    const [fBytes, vBytes] = await Promise.all([load("KeelFactory"), load("KeelVault")]);

    toast("", "1 of 3", "Deploying KeelFactory…");
    const f = await deploy(
      S.account,
      fBytes,
      "c(address,address,address,address)",
      [PROTOCOL.marketsCore, PROTOCOL.binaryModule, PROTOCOL.marketCreatorFactory, PROTOCOL.oracleHub],
      6_000_000n,
    );

    toast("", "2 of 3", "Bootstrapping operator, venue, creator and allowlist…");
    await actions.bootstrap(S.account, f.address, {
      feeRecipient: S.account,
      makerFeeBps: 0,
      takerFeeBps: 0,
      seedPolicy: "0x0000000000000000000000000000000000000000",
      book: BOOK,
    });

    const venueId = await factory.venueId(f.address);
    const creator = await factory.marketCreator(f.address);

    toast("", "3 of 3", "Deploying KeelVault…");
    const v = await deploy(
      S.account,
      vBytes,
      "c(address,address,bytes32,address,address,uint256,(uint256,uint256,uint256,uint256,uint256,uint256))",
      [PROTOCOL.collateral, PROTOCOL.binaryModule, venueId, S.account, S.account, 1000n, SPREAD_CONFIG],
      8_000_000n,
    );

    S.deployment = {
      network: "shannon",
      chainId: SHANNON.chainId,
      deployedAt: new Date().toISOString(),
      deployer: S.account,
      contracts: { KeelFactory: f.address, KeelVault: v.address, marketCreator: creator },
      venueId,
      protocol: PROTOCOL,
    };
    toast(
      "ok",
      "Deployed",
      `Keel is live. <b>Copy these addresses</b> — this page holds them in memory only, so a reload
       loses them unless you also deploy from the CLI:<br>
       <span class="mono">factory ${f.address}</span><br><span class="mono">vault ${v.address}</span>`,
    );
    S.stage = "launch";
    return { hash: v.hash };
  });
}

function doQuote(poolAddr, marketId, fv) {
  const V = S.deployment.contracts.KeelVault;
  const size = Number(el(`q-size-${poolAddr}`)?.value ?? 25);
  return act(`quote-${poolAddr}`, "Quote", async () => {
    const row = await vault.poolRow(V, poolAddr);
    if (!row?.[6]) await actions.registerPool(S.account, V, poolAddr, marketId);
    const amount = toRaw(size, S.decimals);
    await actions.mintSets(S.account, V, poolAddr, amount);
    const fvWad = BigInt(Math.round(fv * 1e6)) * 10n ** 12n;
    return actions.quote(S.account, V, poolAddr, fvWad, amount);
  });
}

const doCancel = (poolAddr) =>
  act(`cancel-${poolAddr}`, "Cancel quotes", () =>
    actions.cancelAll(S.account, S.deployment.contracts.KeelVault, poolAddr));

const doReclaim = (poolAddr) =>
  act(`reclaim-${poolAddr}`, "Reclaim escrow", () =>
    actions.reclaimExpired(S.account, S.deployment.contracts.KeelVault, poolAddr));

const doSettle = (poolAddr) =>
  act(`settle-${poolAddr}`, "Settle", async () => {
    const V = S.deployment.contracts.KeelVault;
    // Skip finalize if the market has already been finalized, so pressing this twice
    // is safe rather than reverting before it ever reaches the redeem.
    if ((await poolReads.finalized(poolAddr)) === false) await actions.finalize(S.account, V, poolAddr);
    return actions.redeemSettled(S.account, V, poolAddr);
  });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  S.deployment = await loadDeployment();
  render();
  await refresh();
  if (S.account && S.chainId === SHANNON.chainId && S.deployment) S.stage = "protocol";
  render();
  onWalletChange(() => refresh().catch(() => {}));
  // A slow poll keeps balances, the roll loop's new windows and settlement states
  // current without fighting whatever the user is in the middle of.
  setInterval(() => {
    if (!S.busy.size) refresh().catch(() => {});
  }, 20000);
})();
