// Pure(-ish) market-maker simulator for the mintSet/burnSet Up+Down quoting
// strategy this repository set out to test. No I/O here — everything this
// module needs (ticks, trades, strike, sigma, outcome) must already be
// fetched by the caller (worker/mmbacktest.js). That separation is what
// makes this file testable with hand-constructed data and no network.
//
// Strategy being simulated, per window:
//   1. At tradingStart, mintSet: pay `mintSize`, receive `mintSize` Up and
//      `mintSize` Down positions.
//   2. Rest asks. Two quoting modes:
//        - legacy flat markup (round 1): Up at P + markup, Down at
//          (1-P) + markup, constant regardless of inventory or clock.
//        - `spreadPolicy` mode (round 2): asks come from
//          worker/spreadPolicy.js, a JS mirror of
//          contracts/src/lib/SpreadPolicy.sol, so the backtest and the
//          on-chain policy cannot drift apart. This adds near-expiry
//          widening (defense 1) and a skew penalty on the side already
//          held (defense 2). See worker/spreadPolicy.js's own comments and
//          worker/test/spreadPolicy.test.js for that formula in isolation.
//   3. Re-quote (cancel + re-post) whenever the model's fair value P has
//      moved by more than `requoteThreshold` since the last quote. In
//      `spreadPolicy` mode, asks are ALSO re-derived immediately after any
//      fill (inventory changed, so the skew term changed) and, while a
//      leftover/unwind episode (see below) is active, on every subsequent
//      tick regardless of the P threshold, because the unwind price is a
//      function of time even when the fair value itself hasn't moved.
//   4. Fill against every historical recorded trade that would have
//      crossed the resting ask, honestly (including adverse fills), up to
//      min(our remaining resting size, the recorded trade's quantity).
//   5. Defense 3, `unwind` (round 2, `spreadPolicy` mode only): once one
//      leg has been sold down relative to the other, the excess ("leftover")
//      leg is deliberately walked DOWN from its normal SpreadPolicy price
//      toward — and, with `unwind.aggressiveness > 0`, potentially below —
//      its own fair value share as the remaining window elapses, to buy
//      back a fill and convert naked directional exposure into a matched
//      pair before expiry. This is the ONE place in this file that may
//      violate SpreadPolicy's solvency invariant (askUp+askDown >=
//      1+2*minSpread) on purpose: that invariant is about never selling a
//      FRESH complete set below what minting it cost, and by the time
//      unwind pricing is in effect we are no longer selling a fresh set —
//      we are unwinding a leg we already hold. The two cases are kept
//      structurally separate below (`deriveAsks`'s `normal` object always
//      satisfies the invariant on its own; only the leftover leg's ask may
//      be overridden by the unwind price, and that override never calls
//      `assertSolvent`).
//   6. At expiry, whatever inventory is left over redeems at 1 if it won,
//      0 if it lost. (Economically this is identical to calling burnSet on
//      the matched portion before expiry -- min(upLeftover, downLeftover)
//      always redeems to exactly that many dollars either way -- so no
//      special-cased burnSet accounting is needed for PnL. A `gasCost` is
//      still charged once per window when NEITHER side ever got a single
//      fill, standing in for that idle burnSet/cleanup call.)
import { fairValue } from "./pricer.js";
import { quote as spreadPolicyQuote } from "./spreadPolicy.js";

const EPS = 1e-9;
const clamp01 = (x) => Math.min(1 - EPS, Math.max(EPS, x));

/**
 * @param {object} params
 * @param {number} params.tradingStart - window open, epoch seconds
 * @param {number} params.expiry - window close, epoch seconds
 * @param {number} params.K - strike (open price)
 * @param {number} params.sigmaS - per-second volatility, trained causally
 *   by the CALLER strictly on ticks before tradingStart (see
 *   worker/mmbacktest.js). This module treats it as an opaque scalar and
 *   never trains it, so there is no way for this function to leak
 *   pre-window future information through sigma.
 * @param {boolean} params.outcomeUp - true if Up won the window
 * @param {Array<{t:number, price:number}>} params.ticks - oracle ticks used
 *   to re-price the quote during the window, ascending by t
 * @param {Array<{t:number, side:'UP'|'DOWN', price:number, quantity:number}>} params.trades
 *   - historical recorded trades that could cross our resting asks,
 *   ascending by t. `price` must already be expressed in that side's own
 *   probability convention (Up trade price and Down trade price both in
 *   [0,1], Down trade price already converted from the shared Up-price
 *   quoting convention by the caller).
 * @param {number} [params.markup=0.01] - s, flat spread markup. Used only
 *   when `spreadPolicy` is not provided (round-1 legacy mode).
 * @param {object} [params.spreadPolicy] - a SpreadPolicy.Config-shaped
 *   object ({baseSpread,minSpread,maxSpread,refTau,skewCoef,maxUrgencyMult}).
 *   When provided, switches quoting to worker/spreadPolicy.js (defenses 1+2).
 * @param {object} [params.unwind] - `{ aggressiveness }`. Only meaningful
 *   when `spreadPolicy` is set. Enables defense 3 (leftover-leg walk-down).
 *   `aggressiveness` (probability units, e.g. 0.02) is how far below the
 *   leftover leg's own fair-value share the ask is willing to go by the
 *   time the remaining window (since the leftover episode began) has fully
 *   elapsed. Even at `aggressiveness=0`, defense 3 still walks the ask down
 *   to (but not below) fair value -- a free, risk-eliminating improvement
 *   over holding a static price to expiry.
 * @param {number} [params.requoteThreshold=0.01] - re-quote when |dP| exceeds this
 * @param {number} [params.mintSize=1] - N, size of the complete set minted at window open
 * @param {number} [params.gasCost=0] - charged once if neither side ever fills
 */
function simulateWindow({
  tradingStart,
  expiry,
  K,
  sigmaS,
  outcomeUp,
  ticks = [],
  trades = [],
  markup = 0.01,
  spreadPolicy = null,
  unwind = null,
  requoteThreshold = 0.01,
  mintSize = 1,
  gasCost = 0,
}) {
  if (!(expiry > tradingStart)) {
    throw new Error("simulateWindow: expiry must be after tradingStart");
  }
  const usePolicy = !!spreadPolicy;

  // ---------------------------------------------------------------------
  // CAUSALITY ENFORCEMENT LIVES HERE.
  //
  // Ticks (which can move our fair value / asks) and trades (which can
  // only consume whatever quote is currently resting) are merged into a
  // single stream sorted ascending by time, with ticks sorted before
  // trades on an exact timestamp tie. We then do ONE forward pass over
  // that stream, mutating `P` / `asks` only from a tick event or from a
  // fill's own inventory change. A trade event can only ever read
  // whatever `asks` currently holds -- which was written by some tick (or
  // an earlier fill) at or before the trade's own timestamp, because any
  // tick *after* the trade sorts later in `events` and, by definition of a
  // single forward loop, has not been reached (and cannot have mutated
  // `asks`) yet. There is no code path by which a later tick can influence
  // an earlier trade's fill decision -- this is structural, not just a
  // convention we're relying on callers to respect.
  // ---------------------------------------------------------------------
  const events = [];
  for (const tick of ticks) {
    if (tick.t < tradingStart || tick.t > expiry) continue; // not this window's business
    events.push({ t: tick.t, kind: "tick", tick });
  }
  for (const trade of trades) {
    if (trade.t < tradingStart || trade.t > expiry) continue;
    events.push({ t: trade.t, kind: "trade", trade });
  }
  events.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    // tie-break: ticks before trades, so a same-timestamp trade sees the
    // freshest same-instant quote rather than a stale one.
    if (a.kind === b.kind) return 0;
    return a.kind === "tick" ? -1 : 1;
  });

  let upInventory = mintSize;
  let downInventory = mintSize;
  let cash = -mintSize; // mintSet at window open

  let P = null; // current fair value (moved only by ticks, gated by requoteThreshold)
  let asks = null; // { askUp, askDown }, derived from P + inventory + tau
  let requoteCount = 0; // P actually re-quoted (round-1-comparable gas proxy)
  let unwindRecomputeCount = 0; // extra time-driven ask recomputes while a leftover episode is active (spreadPolicy+unwind mode only) -- NOT charged any gas, see docs/MM-BACKTEST.md limitations

  // Defense 3 state: which side (if any) currently carries the excess
  // ("leftover") inventory, and the tau that was remaining when this
  // particular imbalance episode began (so "progress" walks from 0 toward
  // 1 over the window remaining AT ONSET, not the whole window).
  let leftover = null; // { side: 'UP'|'DOWN', tauAtOnset }

  let upFilled = 0, downFilled = 0;
  let upFillCount = 0, downFillCount = 0;
  let upRevenue = 0, downRevenue = 0;
  const tradeEvaluations = []; // every in-window trade seen once a quote existed, fill or not -- for incumbent-maker diagnostics (see worker/mmbacktest.js)

  // Derive {askUp, askDown} from the current P, tau and inventory. Called
  // whenever any of those change. In legacy (flat-markup) mode this is
  // just P +/- markup, unchanged from round 1.
  function deriveAsks(tau) {
    if (P === null) {
      asks = null;
      return;
    }
    if (!usePolicy) {
      asks = { askUp: clamp01(P + markup), askDown: clamp01(1 - P + markup) };
      return;
    }

    const pForPolicy = clamp01(P); // spreadPolicy.quote() requires fairValueUp strictly in (0,1)
    const upSkewWad = mintSize > 0 ? upInventory / mintSize : 0;
    const downSkewWad = mintSize > 0 ? downInventory / mintSize : 0;
    // `normal` is the price of selling a piece of a FRESH matched set --
    // this is the object that satisfies SpreadPolicy's solvency invariant
    // (spreadPolicy.quote() asserts it internally). It is what gets used
    // whenever a side is NOT currently the leftover/unwind side.
    const normal = spreadPolicyQuote(spreadPolicy, pForPolicy, Math.max(tau, 0) || 0, upSkewWad, downSkewWad);

    const newLeftoverSide = upInventory > downInventory ? "UP" : downInventory > upInventory ? "DOWN" : null;
    if (newLeftoverSide === null) {
      leftover = null; // matched (or never imbalanced) -- both legs quote normally
    } else if (!leftover || leftover.side !== newLeftoverSide) {
      leftover = { side: newLeftoverSide, tauAtOnset: tau }; // new episode (fresh imbalance, or direction flip)
    } // else: same episode continues -- tauAtOnset is preserved so progress keeps advancing

    let askUp = normal.askUp;
    let askDown = normal.askDown;

    if (unwind && leftover) {
      const isUp = leftover.side === "UP";
      const fairShare = isUp ? P : 1 - P; // NOT pForPolicy -- the unwind floor is allowed to reference true fair value even at P's raw boundary
      const normalAskThisSide = isUp ? normal.askUp : normal.askDown;
      const floor = fairShare - unwind.aggressiveness;
      const progress = leftover.tauAtOnset > 0 ? Math.min(1, Math.max(0, 1 - tau / leftover.tauAtOnset)) : 1;
      let unwoundAsk = normalAskThisSide - progress * (normalAskThisSide - floor);
      unwoundAsk = clamp01(unwoundAsk);
      // Deliberately NOT run through assertSolvent -- see module doc comment.
      if (isUp) askUp = unwoundAsk;
      else askDown = unwoundAsk;
    }

    asks = { askUp, askDown };
  }

  for (const ev of events) {
    if (ev.kind === "tick") {
      const { t, price: S } = ev.tick;
      const tau = expiry - t;
      if (tau <= 0) continue; // nothing left to price
      const p = fairValue(S, K, tau, sigmaS);
      if (P === null || Math.abs(p - P) > requoteThreshold) {
        P = p;
        requoteCount++;
        deriveAsks(tau);
      } else if (usePolicy && unwind && leftover) {
        // Fair value didn't move enough to warrant a full re-quote, but
        // while a leftover leg is being unwound the ask must still walk
        // down purely with time (see deriveAsks / module doc comment) --
        // recompute using the unchanged P but the fresh tau.
        deriveAsks(tau);
        unwindRecomputeCount++;
      }
      continue;
    }

    // ev.kind === "trade"
    const { side, price, quantity, t } = ev.trade;
    if (asks) tradeEvaluations.push({ t, side, price, quoteP: P });
    if (!asks) continue; // nothing resting yet -- cannot be crossed
    if (!(quantity > 0)) continue;

    if (side === "UP") {
      if (upInventory > 0 && price >= asks.askUp) {
        const fillQty = Math.min(quantity, upInventory);
        upInventory -= fillQty;
        const proceeds = fillQty * asks.askUp; // filled AT OUR resting price, not the taker's price
        cash += proceeds;
        upRevenue += proceeds;
        upFilled += fillQty;
        upFillCount++;
        if (usePolicy) deriveAsks(expiry - t);
      }
    } else if (side === "DOWN") {
      if (downInventory > 0 && price >= asks.askDown) {
        const fillQty = Math.min(quantity, downInventory);
        downInventory -= fillQty;
        const proceeds = fillQty * asks.askDown;
        cash += proceeds;
        downRevenue += proceeds;
        downFilled += fillQty;
        downFillCount++;
        if (usePolicy) deriveAsks(expiry - t);
      }
    }
  }

  const redemptionValue = (outcomeUp ? upInventory : 0) + (!outcomeUp ? downInventory : 0);
  cash += redemptionValue;

  const neitherSideFilled = upFilled === 0 && downFilled === 0;
  const bothSidesFilled = upFilled > 0 && downFilled > 0;
  const oneSideFilled = !bothSidesFilled && !neitherSideFilled;

  const gasCharged = neitherSideFilled ? gasCost : 0;
  cash -= gasCharged;

  return {
    pnl: cash,
    mintCost: mintSize,
    upFilled,
    downFilled,
    upFillCount,
    downFillCount,
    upRevenue,
    downRevenue,
    leftoverUp: upInventory,
    leftoverDown: downInventory,
    redemptionValue,
    bothSidesFilled,
    oneSideFilled,
    neitherSideFilled,
    requoteCount,
    unwindRecomputeCount,
    gasCharged,
    finalQuoteP: P,
    tradeEvaluations,
  };
}

export { simulateWindow };
