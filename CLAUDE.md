# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Keep the manifest current

`docs/status.html` is the project's living status page — what exists, what it does,
what has been measured, and how to run it. It is published as an Artifact at:

**https://claude.ai/code/artifact/9e955160-895a-432d-be74-60d9daa9d3a9**

**Whenever you change what the repository contains or what it does, update
`docs/status.html` in the same session and republish it to that same URL** (pass the
URL as `url` if this conversation did not publish it). Things that require an update:

- a new contract, script, or worker module — add it to the inventory with a status chip
- a component moving between `Next`, `Built`, and `Measured`
- new test counts, back-test numbers, or live chain measurements
- a new or changed command in `package.json`
- anything added to or resolved in the "what is needed, and from whom" list

Stale numbers on that page are worse than no page. The counts in the masthead and the
tables are checked figures, not estimates — re-run the suite and read the real values
rather than adjusting them by hand.

## What this is

Entry for the Somnia × DreamDEX Event Contracts Hackathon (submissions close
**8 Sep 2026**). The product is **Keel**: Event Contract markets that open already
quoted. Two surfaces on one engine — **Launch** (permissionlessly create a rolling
Event Contract series for any oracle-fed asset that has none) and **Underwrite** (an
epoch-based vault that manufactures complete sets and rests both sides of the books it
launches).

The full design is in the published Keel artifact
(https://claude.ai/code/artifact/0c4d8cc6-af9a-4ba8-905e-b524c6108bef). Read it before
making product decisions.

`docs/nowcast.html` is a **different, superseded** project. Do not use it as the spec.

### One premise in the design doc is measured false

The doc assumed empty books and no market maker. Live measurement on 2026-09-01 found
every live BTC/ETH window two-sided, with one incumbent churning 400–550 orders per
4-minute window. Two independent back-test runs, with the designed defences on, lose
money against it at every tested parameter. The 45.0%-of-trades-inside-fair diagnostic
in `docs/MM-BACKTEST.md` explains why.

What survives, and is stronger than the doc claimed: **89.0% of 21,883 DreamDEX markets
have never traded, and 32 of 34 oracle-fed assets have no Event Contracts at all.**
Keel's edge exists only where it is the sole maker — on markets it launches itself.
Do not reintroduce "compete for BTC/ETH flow" into the pitch, the README, or the demo.

## Commands

```
npm run setup      # fresh clone -> ready. Idempotent. Installs deps, clones pinned
                   # Solidity libs into contracts/lib, creates .env, runs doctor.
npm test           # 65 Node tests + 54 Foundry tests
npm run doctor     # environment check; prints an exact fix line per failure
npm run chainstate # regenerate live market-structure evidence (network, no wallet)
npm run backtest   # Brier score vs flat-0.5 baseline (network, no wallet, slow)
node worker/mmbacktest.js 300   # reproduce the market-making result
```

Node 20+ (developed against v24), ESM throughout, npm workspaces. Foundry with
`via_ir = true` — the vault does not fit on the stack without it.

## Architecture

### Contracts (`contracts/src/`)

**`lib/SpreadPolicy.sol`** — fair value plus state in, two ask prices out. Near-expiry
widening as `sqrt(refTau/tau)` (fair value's sensitivity to spot scales as `1/sqrt(tau)`,
so this tracks it directly rather than by a tuned ladder), a skew penalty on the side
already held, and the invariant everything rests on:
`askUp + askDown >= 1 + 2 * minSpread`. Selling both legs of a set above par is profit
regardless of the outcome, so a quote that breaks this can lose money even when nothing
goes wrong. Four fuzz properties guard it.

**`KeelVault.sol`** — the underwriting vault. Three design decisions carry the safety
argument and should not be traded away:

1. *Prices are computed on-chain, not accepted.* The quoter key supplies a fair value
   and a size; the contract derives the prices and enforces the invariant. A stolen hot
   key can quote badly, not ruinously, and cannot withdraw.
2. *Share price is struck only when the vault is flat.* Deposits and redemptions queue;
   `rollEpoch` reverts unless every order is dead and every position redeemed, so net
   asset value is just the collateral balance. There is no mark to game.
3. *The exit never touches the operator.* Orders expire with the window, expired escrow
   is reclaimable by anyone, settled positions are redeemable by anyone, and
   `rollEpoch` is permissionless.

Shares carry the collateral's decimals. **A previous version of this file claimed the
epoch design made the first-depositor inflation attack impossible, and that was wrong** —
a security review on 2026-09-03 found the working two-roll variant. Zero-supply pricing
only fixes the roll in which supply leaves zero; an attacker deposits dust, transfers
collateral straight to the contract so it lands in NAV without ever being a queued
deposit, rolls, and the next honest depositor's shares floor to zero. The vault now mints
`DEAD_SHARES` (1e3, to an address with no key) at the first roll that issues any, plus a
`MIN_DEPOSIT` floor. `test_shareInflationAttackLosesMoneyForTheAttacker` runs the attack
end to end.

Two further rules the same review produced, both of which had exploitable holes:

- **`registerPool` trusts the module, never the pool.** It ends in an unlimited approve of
  the collateral to `pool`. When the pool's own `getBinaryPoolParams()` was the only
  source of truth, the quoter could pass a contract naming the real collateral, take an
  infinite allowance and drain everything — bypassing the pricing rails entirely, because
  it never touches them. Provenance now comes from `module.markets(marketId)`: the pool
  address, the collateral and the originating venue all have to match, and the outcome ids
  are taken from the same answer.
- **Launching is priced per unit of runway, not per roll.** All series share one creator
  float. A flat roll count charged a 60-second series what it charged a 7-day one while it
  burned the float 10,080x faster, which starves every honestly funded series behind it.
  `launchCostFor(intervalSec)` scales with cadence.

`worker/spreadPolicy.js` is a line-for-line mirror of the Solidity policy and is tested
against the contract's own reference values. **Change both or neither** — the whole
point is that simulation and chain cannot drift.

### Worker (`worker/`)

**`pricer.js`** — pure math, no I/O. `fairValue(S, K, tau, sigmaS)` implements
`P(Up) = Φ((S − K) / (σₛ·S·√τ))`; `sigmaPerSecond(ticks)` is RMS log-return per second.
Runs identically client-side and in the back-test.

**`backtest.js`** — pulls finalized BINARY markets from the indexer and oracle ticks
from the price feed, reconstructs each window's strike and settlement from ticks
(DreamDEX's own `Market.strike` is unpopulated — always `"0"`), trains σ strictly on
ticks before each window opens, and scores Brier against a flat-0.5 baseline.

**`marketmaker.js` / `mmbacktest.js`** — `simulateWindow()` is pure; the runner caches
its market pull to `data/cache/` so a re-run reproduces the same numbers. Fills are
honest: we are filled only where a recorded trade crossed our resting price.

## Live services

Two GraphQL endpoints, easy to confuse:

- **Indexer** `https://dev.smk.somnia.host/v1/graphql` — on-chain state: `Market`,
  `Order`. DreamDEX venue is
  `0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c`.
- **Price feed** `https://price-feed.dev.oracle.somnia.host/v1/graphql` — `PricePoint`
  (`symbol` like `"BTC/USDC"`, `spot` as an 18-decimal string, `blockTimestamp` in
  epoch seconds). ~34 days retained at ~1.1s resolution.

Traps that have already cost time:

- Hasura caps rows per response. A single large `limit` **silently truncates** — it
  under-reported the market count as 9,551 against a true 21,883. Paginate.
- `Order.status` values are `Open` / `Cancelled` / `Filled`, not uppercase. Order
  timestamps are `placedAtTimestamp`, not `blockTimestamp`.
- `Market.winningOutcome == 0` is Up on the **indexer**, but the on-chain
  `winningOutcome()` getter was removed in settlement v3 and reverts. Contracts must
  read `payoutNumerators()` and take the argmax, gated on `isResolved()`, with
  `isVoided()` disambiguating a uniform vector.

Verified SDK-to-chain mappings, selectors, enums, tick grids, escrow rounding and the
launch path are in `docs/SDK-0.29.0-VERIFIED.md`, with file-and-line citations. Check
there before writing anything that touches the SDK or places real orders.
`docs/SECURITY.md` has the role split and eleven threats tagged built / planned /
accepted.

## Not yet built

- `KeelFactory.sol` — Keel's own operator, venue and market creator. Required, not
  optional: DreamDEX's `MarketCreatorPolicy` allowlist blocks third parties from its
  venue. Because we run our own venue, we also set our own maker/taker fees.
- Live quoter loop, frontend, README, demo recording.
- Anything needing a funded wallet: real order, `mintSet` → `burnSet` round trip.
  Assert `receipt.status === "success"` — it is viem's **string** union, so comparing
  to `1` silently always fails.
