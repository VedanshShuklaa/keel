import test from "node:test";
import assert from "node:assert/strict";

import { planWindow, trainSigma, strikeFrom, DEFAULT_LIMITS } from "../quoter.js";

const NOW = 1_700_000_000;

function base(overrides = {}) {
  return {
    nowSec: NOW,
    market: { expiry: NOW + 120, finalized: false },
    sigmaS: 1e-5,
    openPrice: 100,
    lastTick: { t: NOW - 1, price: 100 },
    inventory: { up: 0, down: 0 },
    freeCollateral: 25,
    minQuantity: 0.001,
    lastQuote: null,
    ...overrides,
  };
}

test("quotes a healthy window", () => {
  const plan = planWindow(base());
  assert.equal(plan.action, "quote");
  assert.ok(plan.fairValueUp > 0 && plan.fairValueUp < 1);
  assert.equal(plan.quantity, 25);
  assert.equal(plan.mint, 25, "with no inventory the whole size must be minted");
});

test("spot at the strike prices the window at a coin flip", () => {
  const plan = planWindow(base());
  assert.ok(Math.abs(plan.fairValueUp - 0.5) < 1e-9);
});

test("spot above the strike prices Up above even money", () => {
  const plan = planWindow(base({ lastTick: { t: NOW - 1, price: 100.5 } }));
  assert.ok(plan.fairValueUp > 0.5);
});

// The rails. Each of these is a case where resting a quote loses money quietly.

test("stops quoting inside the expiry floor", () => {
  const plan = planWindow(base({ market: { expiry: NOW + 5, finalized: false } }));
  assert.equal(plan.action, "cancel");
  assert.match(plan.reason, /below the 20s floor/);
});

test("a stale oracle tick cancels rather than widens", () => {
  const plan = planWindow(base({ lastTick: { t: NOW - 45, price: 100 } }));
  assert.equal(plan.action, "cancel");
  assert.match(plan.reason, /45s old/);
});

test("no volatility estimate means no quote", () => {
  for (const sigmaS of [null, 0, NaN, -1]) {
    assert.equal(planWindow(base({ sigmaS })).action, "cancel");
  }
});

test("no strike means no quote", () => {
  assert.equal(planWindow(base({ openPrice: null })).action, "cancel");
});

test("an expired window is reclaimed, a resolved one is settled", () => {
  assert.equal(planWindow(base({ market: { expiry: NOW - 1, finalized: false } })).action, "reclaim");
  assert.equal(planWindow(base({ market: { expiry: NOW + 120, finalized: true } })).action, "settle");
});

test("no free collateral and no inventory means nothing to quote with", () => {
  const plan = planWindow(base({ freeCollateral: 0 }));
  assert.equal(plan.action, "cancel");
  assert.match(plan.reason, /no collateral free/);
});

test("size under the book minimum is refused, not rounded up", () => {
  const plan = planWindow(base({ freeCollateral: 0.0001, minQuantity: 0.001 }));
  assert.equal(plan.action, "cancel");
  assert.match(plan.reason, /under the book minimum/);
});

test("fair value is clamped away from the boundaries SpreadPolicy rejects", () => {
  const far = planWindow(base({ lastTick: { t: NOW - 1, price: 1e6 } }));
  assert.ok(far.fairValueUp <= DEFAULT_LIMITS.fairValueCeil);
  const near = planWindow(base({ lastTick: { t: NOW - 1, price: 1e-6 } }));
  assert.ok(near.fairValueUp >= DEFAULT_LIMITS.fairValueFloor);
  // Both are strictly inside (0, 1), which is the contract's own precondition.
  assert.ok(far.fairValueUp < 1 && near.fairValueUp > 0);
});

// Hysteresis: cancel-and-replace costs gas and queue position.

test("holds when fair value has barely moved", () => {
  const first = planWindow(base());
  const second = planWindow(
    base({
      nowSec: NOW + 2,
      lastTick: { t: NOW + 1, price: 100.00005 },
      lastQuote: { fairValueUp: first.fairValueUp, quantity: first.quantity, tau: first.tau },
    }),
  );
  assert.equal(second.action, "hold");
});

test("requotes when fair value moves past the threshold", () => {
  const first = planWindow(base());
  const second = planWindow(
    base({
      lastTick: { t: NOW - 1, price: 101 },
      lastQuote: { fairValueUp: first.fairValueUp, quantity: first.quantity, tau: first.tau },
    }),
  );
  assert.equal(second.action, "quote");
});

test("requotes on a large enough move in tau even when fair value has not moved", () => {
  const first = planWindow(base());
  const second = planWindow(
    base({
      nowSec: NOW + 60,
      lastTick: { t: NOW + 59, price: 100 },
      lastQuote: { fairValueUp: first.fairValueUp, quantity: first.quantity, tau: first.tau },
    }),
  );
  assert.equal(second.action, "quote", "widening tracks sqrt(refTau/tau), so tau alone can force a requote");
});

test("inventory already held is not re-minted", () => {
  const plan = planWindow(base({ inventory: { up: 10, down: 10 }, freeCollateral: 5 }));
  assert.equal(plan.quantity, 15);
  assert.equal(plan.mint, 5);
});

test("a lopsided position only counts the matched part as inventory", () => {
  const plan = planWindow(base({ inventory: { up: 10, down: 2 }, freeCollateral: 0 }));
  assert.equal(plan.quantity, 2, "eight unmatched Up are a position, not a set");
  assert.equal(plan.mint, 0);
});

test("the notional ceiling caps the size regardless of the balance", () => {
  const plan = planWindow(base({ freeCollateral: 10_000, limits: { maxNotionalPerWindow: 25 } }));
  assert.equal(plan.quantity, 25);
});

// Sigma training and strike reconstruction.

test("sigma trains only on ticks before the window opened", () => {
  const ticks = [];
  for (let i = 0; i < 200; i++) ticks.push({ t: NOW - 200 + i, price: 100 + Math.sin(i) * 0.01 });
  // Anything at or after the open is a leak; a huge post-open jump must not move it.
  ticks.push({ t: NOW + 5, price: 500 });
  const sigma = trainSigma(ticks, NOW);
  const sigmaWithoutLeak = trainSigma(ticks.slice(0, -1), NOW);
  assert.equal(sigma, sigmaWithoutLeak);
});

test("sigma refuses to guess from too few ticks", () => {
  const ticks = [{ t: NOW - 2, price: 100 }, { t: NOW - 1, price: 101 }];
  assert.equal(trainSigma(ticks, NOW), null);
});

test("the strike is the last tick at or before the open", () => {
  const ticks = [
    { t: NOW - 10, price: 99 },
    { t: NOW - 1, price: 100 },
    { t: NOW + 1, price: 101 },
  ];
  assert.equal(strikeFrom(ticks, NOW), 100);
  assert.equal(strikeFrom([{ t: NOW + 1, price: 101 }], NOW), null);
});
