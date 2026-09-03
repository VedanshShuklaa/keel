// Unit tests for worker/marketmaker.js — the maker simulator.
// Hand-constructed synthetic windows only. No network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateWindow } from "../marketmaker.js";
import { fairValue } from "../pricer.js";

// Shared fixture: strike == spot at window open, so the model's fair value
// P0 is ~0.5 (not bit-exact 0.5 -- pricer.js's erf approximation gives
// normalCdf(0) a ~5e-10 float epsilon -- so tests derive P0/asks from the
// real fairValue() rather than hardcoding 0.5, to stay honest about what
// the pricer actually returns).
const tradingStart = 1000;
const duration = 3600;
const expiry = tradingStart + duration;
const K = 100;
const S = 100; // spot == strike -> P0 ~= 0.5
const sigmaS = 0.0002;

const P0 = fairValue(S, K, duration, sigmaS);

function atmTicks() {
  return [{ t: tradingStart, price: S }];
}

test("both sides filled: profit is exactly 2s, independent of the outcome", () => {
  const s = 0.05;
  const askUp = P0 + s;
  const askDown = 1 - P0 + s;
  const trades = [
    { t: tradingStart + 10, side: "UP", price: askUp, quantity: 1 },
    { t: tradingStart + 20, side: "DOWN", price: askDown, quantity: 1 },
  ];
  for (const outcomeUp of [true, false]) {
    const r = simulateWindow({
      tradingStart, expiry, K, sigmaS, outcomeUp,
      ticks: atmTicks(), trades,
      markup: s, requoteThreshold: 0.01, mintSize: 1, gasCost: 0.02,
    });
    assert.ok(r.bothSidesFilled, "expected both sides filled");
    assert.strictEqual(r.oneSideFilled, false);
    assert.strictEqual(r.neitherSideFilled, false);
    assert.ok(Math.abs(r.pnl - 2 * s) < 1e-9, `pnl=${r.pnl} expected ${2 * s}`);
    assert.strictEqual(r.leftoverUp, 0);
    assert.strictEqual(r.leftoverDown, 0);
    assert.strictEqual(r.gasCharged, 0, "gas is only charged when neither side fills");
  }
});

test("one side filled, leftover wins: profit is the collected premium plus the redeemed leftover", () => {
  const s = 0.05;
  const askUp = P0 + s;
  const askDown = 1 - P0 + s;
  const trades = [
    { t: tradingStart + 10, side: "UP", price: askUp, quantity: 1 },
    // DOWN taker never pays enough to cross our ask.
    { t: tradingStart + 20, side: "DOWN", price: askDown - 0.01, quantity: 1 },
  ];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: false, // Down wins -> leftover Down redeems at 1
    ticks: atmTicks(), trades,
    markup: s, requoteThreshold: 0.01, mintSize: 1, gasCost: 0.02,
  });
  assert.strictEqual(r.oneSideFilled, true);
  assert.strictEqual(r.upFilled, 1);
  assert.strictEqual(r.downFilled, 0);
  assert.strictEqual(r.leftoverDown, 1);
  // pnl = -mint(1) + upRevenue(askUp) + redemption(leftoverDown=1, Down won)
  const expected = -1 + askUp * 1 + 1;
  assert.ok(Math.abs(r.pnl - expected) < 1e-9, `pnl=${r.pnl} expected ${expected}`);
  assert.strictEqual(r.gasCharged, 0);
});

test("one side filled, leftover loses: the unsold directional exposure produces a loss", () => {
  const s = 0.05;
  const askUp = P0 + s;
  const askDown = 1 - P0 + s;
  const trades = [
    { t: tradingStart + 10, side: "UP", price: askUp, quantity: 1 },
    { t: tradingStart + 20, side: "DOWN", price: askDown - 0.01, quantity: 1 }, // doesn't cross
  ];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true, // Up wins -> leftover Down redeems at 0
    ticks: atmTicks(), trades,
    markup: s, requoteThreshold: 0.01, mintSize: 1, gasCost: 0.02,
  });
  assert.strictEqual(r.oneSideFilled, true);
  assert.strictEqual(r.leftoverDown, 1);
  // pnl = -mint(1) + upRevenue(askUp) + redemption(leftoverDown=1, Down lost -> 0)
  const expected = -1 + askUp * 1 + 0;
  assert.ok(Math.abs(r.pnl - expected) < 1e-9, `pnl=${r.pnl} expected ${expected}`);
  assert.strictEqual(r.gasCharged, 0);
});

test("neither side filled: pnl is exactly zero minus the burn/gas cost, independent of outcome", () => {
  const s = 0.05;
  const gasCost = 0.02;
  const askUp = P0 + s;
  const askDown = 1 - P0 + s;
  const trades = [
    { t: tradingStart + 10, side: "UP", price: askUp - 0.1, quantity: 1 }, // below askUp
    { t: tradingStart + 20, side: "DOWN", price: askDown - 0.1, quantity: 1 }, // below askDown
  ];
  for (const outcomeUp of [true, false]) {
    const r = simulateWindow({
      tradingStart, expiry, K, sigmaS, outcomeUp,
      ticks: atmTicks(), trades,
      markup: s, requoteThreshold: 0.01, mintSize: 1, gasCost,
    });
    assert.strictEqual(r.neitherSideFilled, true);
    assert.strictEqual(r.upFilled, 0);
    assert.strictEqual(r.downFilled, 0);
    assert.ok(Math.abs(r.pnl - -gasCost) < 1e-9, `pnl=${r.pnl} expected ${-gasCost}`);
    assert.strictEqual(r.gasCharged, gasCost);
    // Untouched matched pairs always redeem at par (mintSize), regardless of outcome.
    assert.ok(Math.abs(r.redemptionValue - 1) < 1e-9);
  }
});

test("a recorded trade smaller than our resting size only fills up to its own recorded quantity", () => {
  const s = 0.05;
  const askUp = P0 + s;
  const mintSize = 3; // resting size on each side is 3 (all unsold inventory)
  const trades = [
    { t: tradingStart + 10, side: "UP", price: askUp, quantity: 1 }, // smaller than resting size
  ];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks: atmTicks(), trades,
    markup: s, requoteThreshold: 0.01, mintSize, gasCost: 0,
  });
  assert.strictEqual(r.upFilled, 1, "must not fill more than the recorded trade quantity");
  assert.strictEqual(r.leftoverUp, 2);
  assert.strictEqual(r.downFilled, 0);
  assert.strictEqual(r.leftoverDown, 3);
  // pnl = -mint(3) + upRevenue(askUp*1) + redemption(leftoverUp=2 wins @1, leftoverDown=3 loses @0)
  const expected = -3 + askUp * 1 + 2 * 1 + 3 * 0;
  assert.ok(Math.abs(r.pnl - expected) < 1e-9, `pnl=${r.pnl} expected ${expected}`);
});

test("a recorded trade larger than our resting size is capped at our resting size, not the full recorded volume", () => {
  const s = 0.05;
  const askUp = P0 + s;
  const mintSize = 1; // resting size on each side is only 1
  const trades = [
    { t: tradingStart + 10, side: "UP", price: askUp, quantity: 5 }, // far bigger than our size
  ];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks: atmTicks(), trades,
    markup: s, requoteThreshold: 0.01, mintSize, gasCost: 0,
  });
  assert.strictEqual(r.upFilled, 1, "must not fill beyond our own resting size");
  assert.strictEqual(r.leftoverUp, 0);
});

test("fill model is honest: a hurtful fill (price barely crosses, taker was 'right') is still recorded, not filtered out", () => {
  // The taker buys Up right before Up wins -- a bad fill for the maker in
  // hindsight, but it crossed the ask so it MUST be filled. This guards
  // against a tempting bug: silently skipping fills that turn out to be
  // "adverse" after the fact.
  const s = 0.01;
  const askUp = P0 + s;
  const trades = [{ t: tradingStart + 10, side: "UP", price: askUp, quantity: 1 }];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks: atmTicks(), trades,
    markup: s, requoteThreshold: 0.01, mintSize: 1, gasCost: 0,
  });
  assert.strictEqual(r.upFilled, 1);
});

test("no quote yet: a trade before the first tick cannot fill anything", () => {
  const s = 0.05;
  const trades = [{ t: tradingStart - 5, side: "UP", price: 0.99, quantity: 1 }];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks: [{ t: tradingStart + 1, price: S }], // first tick is AFTER the trade
    trades,
    markup: s, requoteThreshold: 0.01, mintSize: 1, gasCost: 0,
  });
  assert.strictEqual(r.upFilled, 0, "a trade before any quote exists cannot cross a nonexistent ask");
});

test("causality: a trade cannot be filled using a tick that happens later in time (no lookahead)", () => {
  // At t=tradingStart, S == K -> P0 ~= 0.5, askUp = P0 + s.
  // A later tick moves price sharply, which would drop P (and askUp) a lot
  // -- but that tick is AFTER the trade, so it must not affect the trade's
  // fill decision. The trade's price is chosen to sit just BELOW the
  // correct askUp but would sit ABOVE a hypothetical post-crash askUp, so
  // if future information leaked backward this trade would incorrectly fill.
  const s = 0.05;
  const askUp = P0 + s;
  const ticks = [
    { t: tradingStart, price: 100 }, // P0 ~= 0.5, askUp = P0 + s
    { t: tradingStart + 100, price: 50 }, // crash, well after the trade
  ];
  const trades = [{ t: tradingStart + 10, side: "UP", price: askUp - 0.03, quantity: 1 }];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks, trades,
    markup: s, requoteThreshold: 0.01, mintSize: 1, gasCost: 0,
  });
  assert.strictEqual(r.upFilled, 0, "future tick must not leak into an earlier trade's fill decision");
});

test("causality tie-break: a trade at the exact same timestamp as a tick sees that tick's quote (tick applied first)", () => {
  const s = 0.05;
  const askUp = P0 + s;
  const ticks = [{ t: tradingStart, price: 100 }]; // P0 ~= 0.5, askUp = P0 + s
  const trades = [{ t: tradingStart, side: "UP", price: askUp, quantity: 1 }];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks, trades,
    markup: s, requoteThreshold: 0.01, mintSize: 1, gasCost: 0,
  });
  assert.strictEqual(r.upFilled, 1);
});

test("re-quote threshold: small fair-value moves below the threshold do not re-quote", () => {
  // First tick sets askUp = P0 + s. Second tick moves P by less than the
  // threshold; a trade after it, priced to cross the ORIGINAL ask, should
  // still fill against that stale (unmoved) quote -- proving the tiny tick
  // did not trigger a re-quote.
  const s = 0.05;
  const askUp = P0 + s;
  const ticks = [
    { t: tradingStart, price: 100 }, // P0 ~= 0.5 (S==K)
    { t: tradingStart + 5, price: 100.001 }, // tiny move, should not trigger re-quote
  ];
  const trades = [{ t: tradingStart + 10, side: "UP", price: askUp, quantity: 1 }];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks, trades,
    markup: s, requoteThreshold: 0.05, mintSize: 1, gasCost: 0,
  });
  assert.strictEqual(r.requoteCount, 1, "the tiny second tick must not cause a second re-quote");
  assert.strictEqual(r.upFilled, 1);
});

test("ticks and trades outside the window are ignored defensively", () => {
  const ticks = [
    { t: tradingStart - 100, price: 999 }, // before window, must be ignored
    { t: tradingStart, price: 100 },
  ];
  const trades = [
    { t: expiry + 100, side: "UP", price: 0.99, quantity: 1 }, // after window, ignored
  ];
  const r = simulateWindow({
    tradingStart, expiry, K, sigmaS, outcomeUp: true,
    ticks, trades,
    markup: 0.05, requoteThreshold: 0.01, mintSize: 1, gasCost: 0,
  });
  assert.strictEqual(r.upFilled, 0);
  assert.strictEqual(r.downFilled, 0);
});
