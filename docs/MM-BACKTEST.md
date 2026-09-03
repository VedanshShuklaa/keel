# Maker strategy back-test: mintSet + resting Up/Down asks

## Round 2 update (read this first)

**Headline: still unprofitable on this data, but for a diagnosed and
partially-addressed reason, and with one honest caveat about what the
sample can prove at all.** Round 1 (below, kept verbatim for comparison)
simulated the strategy stripped of three defenses that exist in the actual
design. Round 2 adds all three — SpreadPolicy-mirrored near-expiry
widening and skew penalty (defenses 1+2), and leftover-leg walk-down
unwind pricing (defense 3) — re-runs against the same live data, and adds
the diagnostic the coordinator asked for. Full detail, formulas, and the
joint parameter sweep are in **[Round 2: defenses 1-3 and the incumbent
diagnostic](#round-2-defenses-1-3-and-the-incumbent-diagnostic)** below.
The short version:

- **Diagnosis confirmed.** 122 of 271 recorded trades (45.0%) executed at
  a price at or inside fair-value + 0.015 — a price we would never have
  been crossed at. The incumbent maker's realized half-spread (median
  0.0184 across all trades, 0.0150 on Up-buys specifically, see below) is
  close to our own
  default markup, meaning it was routinely quoting as tight as or tighter
  than we were and absorbing the flow before it ever reached our price.
  That is consistent with, and does not rule out, the "quoting behind an
  incumbent" mechanism proposed in round 2's brief.
- **Defenses 1+2 (SpreadPolicy) measurably help.** On the identical
  300-window sample, the round-1 flat-markup baseline is **-2.7337**;
  SpreadPolicy quoting with the default leftover-unwind setting is
  **-1.7943** — better, but still a loss.
- **Defense 3 (unwind) does not clearly help on this sample, and at its
  default setting it cost some of defenses 1+2's improvement back.**
  Reported plainly rather than tuned away — see the joint sweep and its
  discussion below.
- **No combination in the joint sweep (baseSpread x aggressiveness) reaches
  break-even.** Best cell: baseSpread=0.05, aggressiveness=0, total PnL
  **-0.3425** across 300 windows. Still a loss, at every combination tested.
- **What this backtest cannot answer, and isn't trying to:** it measures
  Keel competing against an already-established incumbent maker on
  DreamDEX's existing BTC/ETH windows. It says nothing about — and cannot
  say anything about, from history alone — the product's actual target
  case: Keel as the *only* maker on a market it launches itself, on an
  asset with no existing Event Contract. See "What this backtest cannot
  measure" below.

---

## Round 1 (original report, kept for comparison)

**Headline result: the strategy as specified loses money on the sample tested.**
Total PnL across 300 settled DreamDEX BINARY windows at the default markup
(`s = 0.01`) is **-2.68** (units of mintSize, i.e. tUSDC per 1-unit complete
set minted per window), averaging **-0.0089 per window**. Every cell in the
markup/re-quote-threshold sensitivity sweep below is negative — there is no
parameter combination tested where this strategy would have been profitable
on this data. This is a negative result, reported as found; nothing here was
tuned after the fact to look better.

## How to reproduce

```
node worker/mmbacktest.js 300
```

`argv[2]` is the market limit, same convention as `worker/backtest.js`.
First run hits the network (indexer + price-feed, read-only, no wallet); all
fetched ticks/fills are cached under `data/cache/mm-window-<marketId>.json`
(gitignored), so re-running — including the whole sensitivity sweep, which
runs entirely in-memory against the cached windows — does not re-fetch
anything. Delete the `data/cache/mm-window-*.json` files to force a refresh.

Unit tests (no network, hand-computed synthetic windows):

```
node --test worker/test/pricer.test.js worker/test/marketmaker.test.js
```

(See "A note on `node --test worker/test/`" below — the directory form from
the task brief hits a Node v24.10.0 quirk unrelated to this code.)

## Sample

- **Size**: 300 finalized, non-voided DreamDEX BINARY markets (venue
  `0x6797...8a28c`), all 300 usable for simulation (0 skipped — sufficient
  causal training ticks and window ticks were available for every one).
- **Date range**: all 300 windows fall within a single **~9.25-hour span**,
  2026-09-01 04:00:00Z to 2026-09-01 13:15:00Z. This is *not* a broad
  34-day sample — it's the most-recently-settled slice of a testnet whose
  markets are 5-minute windows, so 300 of them is under half a day of
  activity. **This is the single biggest caveat on the headline number**:
  it is one dense burst from one point in time, plausibly dominated by a
  small number of bots/testers rather than diverse market conditions. See
  Limitations below.
- Assets: a mix of BTC and ETH windows.
- Run with a larger `marketLimit` (e.g. `900` or higher) once more testnet
  history accumulates to widen the date range; the harness and cache
  already support it without code changes.

## Methodology (brief — see code for the authoritative version)

- `worker/marketmaker.js` — `simulateWindow()`, pure/no I/O, unit-tested in
  `worker/test/marketmaker.test.js` against hand-computed PnL for: both
  sides filled, one side filled (leftover wins / leftover loses), neither
  side filled, and partial fills in both directions (recorded trade smaller
  than our resting size, and our resting size smaller than the recorded
  trade).
- `worker/mmbacktest.js` — fetches settled windows (indexer `Market`),
  causal training ticks and in-window ticks (price-feed `PricePoint`), and
  the historical trade tape (indexer `Fill`, filtered to `takerSide in
  {BUY_YES, BUY_NO}` — the only sides that can cross an ask; `SELL_YES` /
  `SELL_NO` taker fills cross a resting *bid*, which this asks-only
  strategy never posts).
- Strike `K` and sigma training exactly mirror `worker/backtest.js`'s
  already-verified approach (strike = nearest `PricePoint` at/before
  `tradingStart`; sigma trained causally on `SIGMA_TRAIN_TICKS=1000` ticks
  strictly before `tradingStart`).
- **Fill price convention**: `Fill.fillPrice` is always expressed in the
  shared Up/YES-probability convention (verified empirically:
  `quoteQuantity == quantity * fillPrice` holds identically for both
  `BUY_YES` and `BUY_NO` fills across a live sample). A `BUY_NO` fill's
  effective Down-side price is therefore `1 - fillPrice`. This is not
  documented anywhere in the indexer schema and was reverse-engineered from
  live `Fill` rows this session — flagged here in case it's ever wrong.
- **Causality enforcement** (structural, not just intended — see the long
  comment in `worker/marketmaker.js` above the event loop): ticks and
  trades are merged into one chronologically sorted stream and processed in
  a single forward pass; the resting quote is only ever mutated by a tick
  event, so a trade event can only see a quote written by a tick at or
  before its own timestamp. A dedicated test
  (`causality: a trade cannot be filled using a tick that happens later in
  time (no lookahead)`) constructs a case that would incorrectly fill if
  this were violated.
- **Fill honesty**: every recorded `Fill` that crosses our resting ask is
  filled, including fills that turn out adverse in hindsight (tested
  explicitly — see `fill model is honest: a hurtful fill ... is still
  recorded, not filtered out`). Fill size is `min(our remaining resting
  size, the recorded trade's quantity)` in both directions (tested both
  ways).

## Results (default run: markup `s=0.01`, re-quote threshold `0.01`,
mintSize `1`, gasCost `0.0005`)

| Metric | Value |
|---|---|
| Windows simulated | 300 |
| Total PnL | **-2.6845** |
| PnL per window (avg) | -0.0089 |
| Up filled in N windows | 56 / 300 |
| Down filled in N windows | 17 / 300 |
| Both sides filled | 5 / 300 |
| One side filled | 63 / 300 |
| Neither side filled | 232 / 300 |
| Spread captured (approx, riskless component) | 0.1000 |
| Adverse-selection / drift residual | -2.7845 |
| Worst single-window loss | -0.8975 |
| Best single-window PnL | 0.7394 |
| Max drawdown (chronological cumulative PnL) | -4.3439 |

The single most important number here is the **spread-captured vs
adverse-selection split**: only **5 of 300 windows** ever got both legs
filled (the theoretically risk-free `2s` case), contributing a total of
just `0.10` to PnL. Essentially all of the realized PnL — and essentially
all of the loss — comes from the 63 one-sided fills, where the maker ends
up holding naked directional exposure into settlement. **The strategy as
specified is not, in practice, "market-make and collect the spread" — it's
"get adversely selected on one leg most of the time you get filled at
all."** (This decomposition is itself an approximation — see Limitations.)

### Sensitivity sweep (total PnL / avg PnL per window)

| threshold \ markup | s=0.005 | s=0.01 | s=0.02 | s=0.05 |
|---|---|---|---|---|
| t=0.005 | -4.29 (-0.014) | -2.93 (-0.010) | -1.34 (-0.004) | -1.30 (-0.004) |
| t=0.01  | -3.65 (-0.012) | -2.68 (-0.009) | -1.25 (-0.004) | -1.25 (-0.004) |
| t=0.02  | -2.26 (-0.008) | -1.83 (-0.006) | -2.08 (-0.007) | -0.24 (-0.001) |

**Every single cell is negative.** Widening the markup reduces the loss
(fewer, more selective fills means less adverse selection) but never flips
it to a profit anywhere in the tested range. This strongly suggests the
loss is not primarily a "spread too tight" problem that a bigger markup
alone fixes — see Limitations for why a wider markup in the live system
would also mean far fewer fills than even this backtest shows.

## Limitations — where this simulation is optimistic

Read this section before trusting the headline number for a go/no-go call.

1. **No gas cost per re-quote.** The strategy cancels and re-posts on every
   fair-value move past the threshold; each of those is a real on-chain
   transaction with a real gas cost on Shannon. Only a single flat
   `gasCost` (`0.0005`) is charged per window, and only in the
   never-filled case (standing in for an idle `burnSet` call). A tighter
   re-quote threshold produces more re-quotes for "free" in this model,
   which is not true on-chain.
2. **No latency between a tick and the re-quote landing on-chain.** The
   simulator updates the quote at the exact tick timestamp. In reality
   there is model compute time, RPC round-trip time, and block time before
   a cancel+re-post actually lands, during which the market can move
   further — this simulator cannot be picked off during that window
   because it doesn't model the window at all.
3. **Assumes our resting order is at the front of the queue at its price
   level.** The fill model treats "a historical Fill crossed our ask price"
   as "we get filled up to our size," with no queue position, no other
   makers resting at the same or better price, and no partial-fill
   starvation from being behind other orders. In a live book with multiple
   makers this is the single most optimistic assumption in the model.
4. **Assumes the historical takers' behavior would not have changed in
   response to our quotes being there.** The trade tape is replayed as-is;
   it does not account for our own resting liquidity changing the best
   bid/ask that takers actually saw, changing what they were willing to
   pay, or changing whether they traded at all (e.g. a taker who only
   traded because the *real* market's spread was wide might not have
   traded against our tighter one, or might have traded *more*).
5. **`spreadCaptured` in the aggregate report is an approximation.** It
   assumes every matched (both-sides-filled) unit was priced off the same
   fair-value snapshot for both legs (`askUp + askDown - 1 == 2s` exactly).
   If the quote re-priced between the Up fill and the Down fill for what
   the report treats as "the same matched unit," the true riskless
   component differs slightly; the residual bucket (`adverse-selection /
   drift`) absorbs that drift along with genuine directional PnL and the
   gas charge. Given only 5/300 windows ever had both sides filled, this
   approximation has very little surface area to be wrong on in this run,
   but it would matter more on a sample with a higher both-sides-filled
   rate.
6. **The Fill→Up/Down price-convention decode is empirical, not
   documented.** `Fill.fillPrice` being in the shared Up-probability
   convention (so a `BUY_NO` fill's Down price is `1 - fillPrice`) was
   inferred from `quoteQuantity == quantity * fillPrice` holding for both
   `BUY_YES` and `BUY_NO` rows in a live sample this session, the same way
   `CLAUDE.md` documents the `winningOutcome` convention was inferred. If
   this is wrong, every Down-side fill decision in this report is wrong
   (the Up-side result would be unaffected).
7. **Sample is a single dense ~9.25-hour burst** (see Sample section), not
   a broad, calendar-diverse sample. It may be dominated by a small number
   of testnet bot addresses rather than representative market conditions.
   Re-running with a larger `marketLimit` as more testnet history
   accumulates is cheap (the code already supports it) and should be done
   before treating this as a final verdict.
8. **`sigmaPerSecond`'s degenerate zero-volatility branch has a real bug**
   (found while writing `worker/test/pricer.test.js`, not fixed per the
   task instructions — see below). It doesn't affect this backtest in
   practice (real markets never have exactly zero measured volatility with
   1000 training ticks), but it's a landmine for anyone who later feeds
   this pricer a synthetic or heavily-smoothed tick series.
9. **No trading fees / protocol fees** other than the mint/burn par cost
   already modeled. If DreamDEX charges a taker or maker fee on fills, it
   is not in this model and would make the result worse, not better.
10. **No slippage on the mint itself** — `mintSize=1` is minted at the
    start of every window regardless of how the strategy is expected to
    perform in it; there's no "skip this window, the spread doesn't look
    worth it" logic, which a live deployment would presumably add and
    which would likely change which windows dominate the PnL.

## Bug found in `worker/pricer.js` (reported round 1, fixed round 2)

**Update: fixed.** `fairValue`'s `denom <= 0` branch originally returned
`S >= K ? 1 : 0.5` for the zero-volatility case. It has since been changed
to `S >= K ? 1 : 0`, matching the `tau <= 0` branch's own deterministic
convention, and the `node:test` `todo` test that pinned this bug in
`worker/test/pricer.test.js` has been converted into an active, passing
test (`fairValue: zero volatility resolves deterministically, matching the
tau<=0 convention`). The original round-1 writeup is preserved below for
the record; this repo's `pricer.js` no longer has the bug it describes.

Original round-1 finding, for the record: `fairValue`'s `denom <= 0` branch
(reached when `sigmaS` is exactly 0, i.e. truly zero measured volatility,
with positive time remaining) used to return `S >= K ? 1 : 0.5`. Zero
volatility means the price cannot move again before expiry — that's a
*fully deterministic* outcome, matching the `tau <= 0` branch's own
convention of `S >= K ? 1 : 0`. But the `S < K` case returned `0.5`
("maximum uncertainty") instead of `0` ("certain Down") — the opposite of
what zero volatility actually implies. This never affected the backtest
numbers above or below (sigma is trained on real ticks and is never
exactly 0 in this data).

## A note on `node --test worker/test/` (resolved round 2)

**Update: fixed.** The root `package.json`'s `test:unit` script now reads
`node --test "worker/test/*.test.js"` (a glob) instead of a bare directory
argument, so `npm test` runs clean. Original round-1 finding, for the
record: on the Node v24.10.0 build this repo ran on, `node --test
worker/test/` (bare directory argument) threw `Cannot find module
'.../worker/test'` — reproduced in a from-scratch empty sandbox unrelated
to this repo's contents, so it was a Node version quirk in
directory-argument handling, not a bug in these test files. Both of the
following still work regardless:

```
node --test                              # default recursive discovery from cwd
node --test worker/test/*.test.js        # explicit glob
```

---

## Round 2: defenses 1-3 and the incumbent diagnostic

This section is new. It re-runs the identical backtest harness (`node
worker/mmbacktest.js 300` — same command, now prints this section too)
with the three previously-unmodelled defenses added, plus the diagnostic
requested to check the round-1 mechanism.

### A sampling note, up front

Round 1's 300-window sample and round 2's 300-window sample are **not
byte-identical**. `fetchFinalizedMarkets` asks the indexer for "the most
recently settled 300 BINARY markets," which is a moving target — the venue
keeps settling new 5-minute windows in real time, and round 2 was run
later in the same working session than round 1. As of round 2,
`worker/mmbacktest.js` now caches the market list itself
(`data/cache/markets-<limit>.json`, not just each market's ticks/fills as
in round 1), so **this exact 300-window sample is now pinned** and
`node worker/mmbacktest.js 300` will reproduce round 2's numbers exactly
from here on (delete that one cache file to intentionally re-sample the
current "most recent 300"). Its date range is 2026-09-01T04:00:00Z to
2026-09-01T13:45:00Z (~9.75 hours) — the same "single dense burst" caveat
from round 1's Sample section applies unchanged.

Because of this, the round-1 baseline number printed inside round 2's own
report (**-2.7337**) is the flat-markup strategy re-run on round 2's
sample, and differs slightly from round 1's original standalone headline
(**-2.68**, on round 1's own, earlier, sample). The round-1-vs-round-2
*comparisons made within this section* are apples-to-apples (same
`windows` array for both, computed in the same run of `main()` in
`worker/mmbacktest.js`); the two reports' raw headline numbers, taken in
isolation, are not from the same sample and are not directly comparable
to each other.

### Diagnostic: was round 1 quoting behind an incumbent?

`worker/marketmaker.js`'s `simulateWindow()` now returns `tradeEvaluations`
— for every recorded trade in-window (fill or not), the causal fair value
`P` in effect at that instant (a pure function of ticks/sigma/K, so it does
not depend on which markup/policy config produced the report it's attached
to). `worker/mmbacktest.js`'s `analyzeIncumbent()` turns that into: for
every trade, its **implied half-spread over fair value** — `price - P` for
an Up buy, `P - price` for a Down buy — which is what an incumbent maker
resting an ask at that price would have been charging over fair value at
that moment. Result, across all 271 in-window trades in the pinned sample:

| Metric | Value |
|---|---|
| Trades evaluated | 271 (188 Up-buys, 83 Down-buys) |
| Median implied half-spread (all) | 0.0184 |
| Median implied half-spread, Up-buys | 0.0150 |
| Median implied half-spread, Down-buys | 0.1378 |
| Mean implied half-spread (all) | 0.0074 |
| Fraction at/inside fair-value + 0.015 | **122 / 271 = 45.0%** |

Reading this plainly: **45% of all recorded trades executed at a price we
would never have been crossed at**, because it was at or inside our own
reference markup (0.015, SpreadPolicy's `baseSpread`) away from fair
value. Those trades cleared against someone else's tighter resting order.
The Up-side median half-spread (0.0150) sits almost exactly on our
reference markup — on the Up side specifically, an incumbent (or the
aggregate of whoever else is quoting) was routinely pricing about as
tightly as we would have, which is sufficient on its own to explain why we
lose most of that flow to them rather than filling it ourselves. The
Down-side median half-spread is much wider (0.1378) but from only 83
observations concentrated in specific windows, so it is noisier and should
not be read as "Down liquidity is thin" with the same confidence as the Up
number.

This is **consistent with, and does not contradict**, the "quoting behind
an incumbent, which selects for exactly the takers we least want" diagnosis
proposed by the coordinator. It does not, on its own, *prove* a single
address is running one continuous maker strategy across every window in
this sample (this analysis does not look at `Fill.maker`/`taker` addresses
at all) — but it does confirm the necessary precondition: our reference
price was very often not the tightest price available, which is the
mechanism that would produce exactly the fill pattern round 1 showed (232
no-fill windows, losses concentrated in the one-sided fills).

### Defense 1 + 2: `worker/spreadPolicy.js`

`worker/spreadPolicy.js` is a line-for-line JS port of
`contracts/src/lib/SpreadPolicy.sol` (WAD-integer Solidity math ported to
plain [0,1] floats — the algebra and branch order match; only the
fixed-point-vs-floating-point numeric representation differs, which is
unavoidable and not a behavioural change). It implements:

- **`urgencyMultiplier(cfg, tau)`** — defense 1, near-expiry widening.
  Widens by `sqrt(refTau / tau)`, capped at `maxUrgencyMult`. Fair value's
  sensitivity to spot scales as `1/sqrt(tau)`, so this tracks that
  sensitivity directly rather than a hand-tuned ladder, exactly as
  specified.
- **`skewPenalty(cfg, skewWad)`** — defense 2. `1 + skewCoef * skewWad`,
  multiplied into the base spread for each leg independently from that
  leg's OWN inventory-as-fraction-of-NAV (`upSkewWad` widens only
  `askUp`; `downSkewWad` widens only `askDown` — verified against
  `contracts/test/SpreadPolicy.t.sol`'s
  `test_quote_skewOnOneSideLeavesTheOtherAlone`).
- **`quote(cfg, fairValueUp, tau, upSkewWad, downSkewWad)`** — combines
  both, clamps each leg's spread to `[minSpread, maxSpread]`, and pulls a
  leg back from the ≥1 boundary onto the other leg to preserve the sum
  (mirrors the Solidity "+1 wei" nudge with a small float `EPS` instead).
- **`assertSolvent`** — the one hard invariant, `askUp + askDown >= 1 +
  2*minSpread`, asserted internally by `quote()` exactly as the contract
  does.

All of `worker/spreadPolicy.js` is unit-tested in
`worker/test/spreadPolicy.test.js` against reference values taken directly
from `contracts/test/SpreadPolicy.t.sol` (same config: `baseSpread=0.015,
minSpread=0.005, maxSpread=0.08, refTau=900, skewCoef=0.5,
maxUrgencyMult=6`), including the exact `sqrt(900/225)==2` urgency check
and a 6-parameter-combination grid asserting the solvency invariant never
breaks (24 tests, all passing; `npm test` also runs the 24 Foundry tests
for the Solidity original).

**Modeling choice, stated explicitly:** SpreadPolicy's `upSkewWad` /
`downSkewWad` are documented as "long Up/Down inventory as a fraction of
NAV." This backtest is single-window (one `mintSet` at window open, no
ongoing multi-window vault), so there is no real "vault NAV" to reference.
`worker/marketmaker.js` uses `mintSize` (this window's own mint) as that
denominator: `upSkewWad = upInventory / mintSize`. This is a literal,
defensible reading of the doc comment, but it is a simplification — the
real on-chain vault's NAV is shared across every concurrently-open window,
so a live skew term would typically be a much smaller fraction (this one
window is a small slice of a much bigger vault) than what this
single-window simulation computes (which starts every window at
`upSkewWad = downSkewWad = 1.0`, both "fully long," before any fill).

### Defense 3: leftover-leg unwind

Implemented in `worker/marketmaker.js`'s `deriveAsks()`. Once
`upInventory != downInventory`, the side holding the excess ("leftover")
is tracked with the tau that was remaining when that particular imbalance
episode began (`tauAtOnset`). While the episode is active, that side's ask
is walked from the normal SpreadPolicy price toward — and, with
`unwind.aggressiveness > 0`, below — its own fair-value share, linearly in
`progress = 1 - tau/tauAtOnset`:

```
floor      = fairShare - aggressiveness
unwoundAsk = normalAsk - progress * (normalAsk - floor)
```

At `aggressiveness = 0` this still walks the ask down to (but never below)
fair value by the time the episode's remaining window has fully elapsed —
a free, risk-eliminating improvement over holding a static price, since
selling a naked leg at exactly fair value removes the outcome risk at zero
expected cost. `aggressiveness > 0` is willingness to sell at an
increasing loss as expiry nears, on the logic that a bounded, certain loss
can beat an unbounded, uncertain one. The episode resets (both legs quote
normally again) if the position becomes matched again.

**The invariant is deliberately not enforced here.** SpreadPolicy's
`askUp + askDown >= 1 + 2*minSpread` is about never selling a *fresh
matched set* below what minting it cost. By the time unwind pricing is
active we are not selling a fresh set — the other leg already sold, and
we are unwinding a directional position we already hold. `deriveAsks()`
keeps these structurally separate: the `normal` object it computes always
satisfies the invariant on its own (`spreadPolicyQuote()` asserts this
internally, same as the Solidity original), and only the leftover leg's
ask is ever overridden by `unwoundAsk`, which never calls `assertSolvent`.
This is tested directly in `worker/test/marketmaker-round2.test.js`
(`invariant separation: ...`): a constructed scenario forces a leftover
fill priced below the matched-set floor, while confirming a fresh quote at
the same fair value would have satisfied the invariant.

### Results

Same 300-window pinned sample throughout this subsection.

| Configuration | Total PnL | Avg / window |
|---|---|---|
| Round 1, flat markup `s=0.01` (baseline, re-run on this sample) | -2.7337 | -0.0091 |
| Round 2 default: SpreadPolicy (`baseSpread=0.015`) + unwind (`aggressiveness=0.02`) | **-1.7943** | -0.0060 |

Defenses 1+2 alone (SpreadPolicy dynamic widening and skew pricing,
replacing the flat markup) are the main source of that improvement — see
the joint sweep's `aggressiveness=0` column below, which isolates it.

#### Joint sweep: `baseSpread` x `unwind.aggressiveness` (total PnL, 300 windows)

`minSpread=0.005, maxSpread=0.08, refTau=900, skewCoef=0.5,
maxUrgencyMult=6` held fixed at `contracts/test/SpreadPolicy.t.sol`'s exact
values throughout (these mirror the deployed on-chain policy; they are not
free dials for this exercise). `baseSpread` and `unwind.aggressiveness`
are swept jointly, not one at a time:

| baseSpread \ aggressiveness | a=0 | a=0.005 | a=0.01 | a=0.02 | a=0.05 |
|---|---|---|---|---|---|
| s=0.005 | -3.5707 | -3.8421 | -3.8528 | -4.4381 | -4.1388 |
| s=0.01  | -2.4509 | -2.4556 | -2.7255 | -2.7430 | -2.9842 |
| s=0.015 | -1.5058 | -1.5106 | -1.5154 | -1.7943 | -2.4153 |
| s=0.02  | -2.1120 | -2.1123 | -2.1125 | -2.1131 | -2.6777 |
| s=0.05  | -0.3425 | -0.3425 | -0.3425 | -0.3425 | -0.3425 |

**Best cell: `baseSpread=0.05, aggressiveness=0`, total PnL = -0.3425.**
**No cell in this 25-combination grid reaches break-even.** Stated
plainly, as instructed: even with all three specified defenses modeled
against real data, this sample does not show a profitable configuration.

#### An honest read on defense 3

Defense 3 does engage on real data — in a 30-window spot check, 10/30
windows produced at least one leftover episode, and the `aggressiveness`
parameter measurably changed which trades filled. But **on this sample it
does not clearly help, and at its own default setting it gave back some of
defenses 1+2's improvement**: at `baseSpread=0.015`, `aggressiveness=0`
scores -1.5058 while `aggressiveness=0.02` (the round-2 default used for
the headline comparison above) scores -1.7943 — worse. The pattern in the
table (aggressiveness rarely helps, and often mildly hurts, at every fixed
`baseSpread`) suggests a plausible mechanism, offered as a hypothesis, not
a proven cause: on a sample where the maker was already losing to a
tighter incumbent most of the time, discounting the leftover leg mostly
gives away edge on fills that would have redeemed favorably anyway
(selling into your own eventual win), while the trades that were always
going to be adverse regardless of the incumbent's presence remain adverse
regardless of how the leftover leg is priced. Confirming or ruling this
out would need per-window attribution of *which* unwind fills would have
redeemed which way absent the discount — not done here, flagged as future
work rather than asserted.

### Additional round-2 limitations (on top of round 1's list, still all true)

1. **`unwindRecomputeCount` is not gas-charged**, same optimism as round
   1's "no gas cost per re-quote" limitation — and now more consequential,
   since defense 3 implies materially more on-chain re-quoting in practice
   than round 1's flat-markup model ever accounted for.
2. **The single-window NAV proxy for `upSkewWad`/`downSkewWad`** (see
   Defense 1+2 section above) likely overstates skew-driven widening
   relative to a real multi-window vault, where any one window is a small
   fraction of total NAV.
3. **The spread-captured/adverse-selection decomposition from round 1's
   report is not re-derived for round 2** (SpreadPolicy's per-fill spread
   is no longer a fixed `2s`, so that specific approximation formula no
   longer applies cleanly); the round-2 section above reports total PnL
   and the joint sweep instead, without attempting a new decomposition.
4. **The incumbent diagnostic uses a single reference markup (0.015)** to
   classify "inside/outside," rather than each sweep cell's own dynamic
   SpreadPolicy ask; it's a fixed yardstick chosen for a simple, legible
   number, not a per-configuration exact accounting.

### What this backtest cannot measure

Stated explicitly, as its own point, not buried in the limitations list
above: **this entire exercise — round 1 and round 2 alike — measures Keel
competing against an already-established incumbent maker on DreamDEX's
existing BTC and ETH windows.** That is not the product. The product is
Keel being the *only* maker on a market it launches itself, for one of the
32 oracle-fed assets that currently have no Event Contracts at all, where
a taker who wants exposure has no tighter quote to hit than ours. That
case has no trading history on any venue — it cannot be back-tested, full
stop, because the data required to back-test it (a market that already
exists and already has an incumbent) is definitionally the wrong data for
it. It can only be demonstrated live.

Both things are true at once, deliberately, and neither should be used to
discount the other: the negative result above is real and should not be
waved away by "but the real product is different" — it is a genuine,
reproducible finding about competing on an already-quoted market with this
specific pricing model. And the real product's actual claim — being first
and only on an unserved market — is a genuinely different situation that
this data, by construction, cannot speak to either way.
