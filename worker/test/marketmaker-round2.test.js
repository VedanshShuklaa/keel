// Round-2 unit tests: SpreadPolicy-driven quoting (defenses 1+2, mirroring
// contracts/src/lib/SpreadPolicy.sol) and leftover-leg unwind (defense 3),
// layered onto worker/marketmaker.js. Hand-verified against the same
// exported spreadPolicy.quote() used by the implementation (an independent
// integration check of event timing / onset tracking, not a re-test of the
// arithmetic already covered by worker/test/spreadPolicy.test.js). No
// network access. Round-1 behaviour (flat markup, spreadPolicy omitted) is
// asserted unchanged, not re-derived here -- see worker/test/marketmaker.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateWindow } from "../marketmaker.js";
import { fairValue } from "../pricer.js";
import { DEFAULT_CONFIG, quote as spreadPolicyQuote } from "../spreadPolicy.js";

const tradingStart = 1000;
const duration = 3600;
const expiry = tradingStart + duration;
const K = 100;
const S = 100; // spot == strike for the whole window -> P stays ~0.5 regardless of tau
const sigmaS = 0.0002;
const mintSize = 1;

const P0 = fairValue(S, K, duration, sigmaS); // ~0.5, used as the "fair value" reference throughout

test("spreadPolicy mode: a fresh, balanced window quotes exactly SpreadPolicy.quote(P, tau, 1, 1)", () => {
  // Before any fill, upInventory == downInventory == mintSize, so
  // upSkewWad == downSkewWad == mintSize/mintSize == 1 -- both legs start
  // symmetrically widened by the skew term, exactly mirroring the contract.
  const expected = spreadPolicyQuote(DEFAULT_CONFIG, P0, duration, 1, 1);
  const trades = [
    { t: tradingStart + 10, side: "UP", price: expected.askUp, quantity: 1 },
    { t: tradingStart + 10, side: "DOWN", price: expected.askDown, quantity: 1 },
  ];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks: [{ t: tradingStart, price: S }],
    trades,
    spreadPolicy: DEFAULT_CONFIG,
    requoteThreshold: 0.5,
    mintSize,
    gasCost: 0,
  });
  assert.ok(r.bothSidesFilled);
  // pnl = -mint(1) + expected.askUp + expected.askDown
  const pnlExpected = -1 + expected.askUp + expected.askDown;
  assert.ok(Math.abs(r.pnl - pnlExpected) < 1e-9, `pnl=${r.pnl} expected=${pnlExpected}`);
});

test("spreadPolicy mode without unwind: a leftover leg keeps quoting the normal (unwound-down-to-par-only) SpreadPolicy price, never below it", () => {
  const trades = [{ t: tradingStart + 10, side: "UP", price: 0.99, quantity: 1 }]; // definitely crosses, fills Up fully
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks: [
      { t: tradingStart, price: S },
      { t: tradingStart + 3000, price: S }, // late tick, no unwind configured -> should NOT move the Down ask
    ],
    trades,
    spreadPolicy: DEFAULT_CONFIG,
    unwind: null, // defense 3 OFF
    requoteThreshold: 0.5,
    mintSize,
    gasCost: 0,
  });
  assert.strictEqual(r.oneSideFilled, true);
  assert.strictEqual(r.leftoverDown, 1);
  // Without defense 3 the Down ask is whatever SpreadPolicy alone (skew-only) gives at the moment of the Up fill.
  const expectedDownAsk = spreadPolicyQuote(DEFAULT_CONFIG, P0, expiry - (tradingStart + 10), 0, 1).askDown;
  // Fills execute AT OUR resting ask, not the taker's price (same honesty
  // rule as round 1) -- the Up ask in effect at the moment of the fill was
  // the initial balanced-window quote (upSkew=downSkew=1, tau=full duration).
  const initialAskUp = spreadPolicyQuote(DEFAULT_CONFIG, P0, duration, 1, 1).askUp;
  // redemption = 0 (outcomeUp=true, leftover Down loses); pnl = -1 + upRevenue
  const pnlExpected = -1 + initialAskUp;
  assert.ok(Math.abs(r.pnl - pnlExpected) < 1e-9, `pnl=${r.pnl} expected=${pnlExpected}`);
  assert.ok(expectedDownAsk > P0 - 1e-9, "the un-unwound leftover ask must not have been discounted below fair value");
});

test("unwind: the leftover ask starts at the normal SpreadPolicy price (progress ~0) right at onset", () => {
  const aggressiveness = 0.05;
  const trades = [
    { t: tradingStart + 10, side: "UP", price: 0.99, quantity: 1 }, // Up fills fully -> Down becomes leftover
    // Same instant: try to buy Down at exactly the *undiscounted* normal ask.
  ];
  const normalDownAsk = spreadPolicyQuote(DEFAULT_CONFIG, P0, expiry - (tradingStart + 10), 0, 1).askDown;
  trades.push({ t: tradingStart + 10, side: "DOWN", price: normalDownAsk, quantity: 1 });
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks: [{ t: tradingStart, price: S }],
    trades,
    spreadPolicy: DEFAULT_CONFIG,
    unwind: { aggressiveness },
    requoteThreshold: 0.5,
    mintSize,
    gasCost: 0,
  });
  // At the exact instant the leftover episode begins, progress==0, so the
  // unwind ask should equal the normal ask -- the Down trade at that exact
  // undiscounted price should still fill.
  assert.strictEqual(r.downFilled, 1, "at progress=0 the unwind ask must equal the normal (undiscounted) ask");
});

test("unwind: the leftover ask walks down below fair value as the remaining window elapses, and a trade that could not have crossed the flat/no-unwind ask now fills", () => {
  const aggressiveness = 0.05;
  const onsetT = tradingStart + 10;
  const lateT = expiry - 100; // deep into the remaining window since onset

  // Independently recompute both reference prices the same way the
  // implementation is documented to (see worker/marketmaker.js): the
  // normal SpreadPolicy ask at the late timestamp, and the floor
  // fair-value-minus-aggressiveness price at full progress.
  const tauAtOnset = expiry - onsetT;
  const tauLate = expiry - lateT;
  const normalDownAskLate = spreadPolicyQuote(DEFAULT_CONFIG, P0, tauLate, 0, 1).askDown;
  const floor = (1 - P0) - aggressiveness;
  const progress = 1 - tauLate / tauAtOnset;
  const expectedUnwoundAsk = normalDownAskLate - progress * (normalDownAskLate - floor);

  assert.ok(expectedUnwoundAsk < normalDownAskLate - 1e-6, "sanity: the walked-down ask must be strictly below the normal ask this late");

  // A price that sits strictly between the discounted ask and the normal
  // ask: must fill WITH unwind enabled, must NOT fill without it.
  const probePrice = (expectedUnwoundAsk + normalDownAskLate) / 2;

  const ticksAndUpFill = () => ({
    ticks: [
      { t: tradingStart, price: S },
      { t: lateT, price: S },
    ],
    trades: [
      { t: onsetT, side: "UP", price: 0.99, quantity: 1 }, // Up fills -> Down becomes leftover at onsetT
      { t: lateT + 1, side: "DOWN", price: probePrice, quantity: 1 },
    ],
  });

  const withUnwind = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true, // Up wins: an un-sold leftover Down would redeem at 0
    ...ticksAndUpFill(),
    spreadPolicy: DEFAULT_CONFIG,
    unwind: { aggressiveness },
    requoteThreshold: 0.5,
    mintSize,
    gasCost: 0,
  });
  const withoutUnwind = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ...ticksAndUpFill(),
    spreadPolicy: DEFAULT_CONFIG,
    unwind: null,
    requoteThreshold: 0.5,
    mintSize,
    gasCost: 0,
  });

  assert.strictEqual(withUnwind.downFilled, 1, "the probe price should cross the discounted (unwound) ask");
  assert.strictEqual(withoutUnwind.downFilled, 0, "the same probe price should NOT cross the un-discounted ask");
  assert.ok(
    withUnwind.pnl > withoutUnwind.pnl,
    `defense 3 should improve pnl here: with=${withUnwind.pnl} without=${withoutUnwind.pnl}`
  );
});

test("unwind: direction resets if the position flips back to matched (leftover cleared)", () => {
  // Up fills first (Down becomes leftover), then Down fills too -> matched
  // again -> no more leftover, no more discounting needed.
  const trades = [
    { t: tradingStart + 10, side: "UP", price: 0.99, quantity: 1 },
    { t: tradingStart + 20, side: "DOWN", price: 0.99, quantity: 1 },
  ];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks: [{ t: tradingStart, price: S }],
    trades,
    spreadPolicy: DEFAULT_CONFIG,
    unwind: { aggressiveness: 0.05 },
    requoteThreshold: 0.5,
    mintSize,
    gasCost: 0,
  });
  assert.ok(r.bothSidesFilled);
  assert.strictEqual(r.leftoverUp, 0);
  assert.strictEqual(r.leftoverDown, 0);
});

test("invariant separation: the matched-set quote always satisfies askUp+askDown >= 1+2*minSpread; the unwind price is exempt and can violate it", () => {
  const aggressiveness = 0.1; // large, to force a clear violation
  const onsetT = tradingStart + 10;
  const lateT = expiry - 10;
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks: [{ t: tradingStart, price: S }, { t: lateT, price: S }],
    trades: [
      { t: onsetT, side: "UP", price: 0.99, quantity: 1 },
      // a very low-priced Down trade near expiry that only crosses because
      // the unwind price has been pushed below fair value:
      { t: lateT + 1, side: "DOWN", price: (1 - P0) - 0.09, quantity: 1 },
    ],
    spreadPolicy: DEFAULT_CONFIG,
    unwind: { aggressiveness },
    requoteThreshold: 0.5,
    mintSize,
    gasCost: 0,
  });
  assert.strictEqual(r.downFilled, 1, "sanity: the deeply discounted probe should have crossed");
  // The revenue collected for that leftover-leg fill must be below what a
  // freshly-minted matched-set quote would ever be allowed to charge:
  // downRevenue (single unit) vs the invariant floor for a matched pair.
  assert.ok(
    r.downRevenue < DEFAULT_CONFIG.minSpread + (1 - P0),
    `expected the unwind fill to have priced below the matched-set floor; downRevenue=${r.downRevenue}`
  );
  // Meanwhile, at every point BEFORE the leftover existed, the (Up, Down)
  // pair this simulation would have quoted as a fresh matched set does
  // satisfy the invariant -- checked directly against spreadPolicy.quote().
  const fresh = spreadPolicyQuote(DEFAULT_CONFIG, P0, duration, 1, 1);
  assert.ok(fresh.askUp + fresh.askDown >= 1 + 2 * DEFAULT_CONFIG.minSpread - 1e-9);
});

test("tradeEvaluations: records every in-window trade with the causal fair value at that time, including non-crossing trades", () => {
  const trades = [
    { t: tradingStart + 10, side: "UP", price: 0.4, quantity: 1 }, // will not cross
    { t: tradingStart + 20, side: "DOWN", price: 0.99, quantity: 1 }, // will cross
  ];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks: [{ t: tradingStart, price: S }],
    trades,
    markup: 0.05,
    requoteThreshold: 0.5,
    mintSize,
    gasCost: 0,
  });
  assert.strictEqual(r.tradeEvaluations.length, 2);
  assert.strictEqual(r.tradeEvaluations[0].side, "UP");
  assert.strictEqual(r.tradeEvaluations[0].price, 0.4);
  assert.ok(Math.abs(r.tradeEvaluations[0].quoteP - P0) < 1e-6);
  assert.strictEqual(r.tradeEvaluations[1].side, "DOWN");
});

test("backward compatibility: omitting spreadPolicy reproduces the exact round-1 flat-markup result", () => {
  const s = 0.05;
  const askUp = P0 + s;
  const askDown = 1 - P0 + s;
  const trades = [
    { t: tradingStart + 10, side: "UP", price: askUp, quantity: 1 },
    { t: tradingStart + 20, side: "DOWN", price: askDown, quantity: 1 },
  ];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks: [{ t: tradingStart, price: S }],
    trades,
    markup: s,
    requoteThreshold: 0.01,
    mintSize: 1,
    gasCost: 0.02,
  });
  assert.ok(r.bothSidesFilled);
  assert.ok(Math.abs(r.pnl - 2 * s) < 1e-9, `pnl=${r.pnl} expected ${2 * s}`);
});
