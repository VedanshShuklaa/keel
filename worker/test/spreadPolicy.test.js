// Unit tests for worker/spreadPolicy.js — a JS mirror of
// contracts/src/lib/SpreadPolicy.sol, so the backtest and the on-chain
// policy cannot silently drift apart. Reference values below are taken
// directly from contracts/test/SpreadPolicy.t.sol (same config, same
// assertions in spirit) so this port can be checked against the Solidity
// source of truth rather than against itself. No network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  validate,
  urgencyMultiplier,
  skewPenalty,
  quote,
  assertSolvent,
} from "../spreadPolicy.js";

// Exactly contracts/test/SpreadPolicy.t.sol's setUp() config.
const cfg = {
  baseSpread: 0.015,
  minSpread: 0.005,
  maxSpread: 0.08,
  refTau: 900,
  skewCoef: 0.5,
  maxUrgencyMult: 6,
};

// --- validate -------------------------------------------------------------

test("validate: accepts the sane reference config", () => {
  assert.doesNotThrow(() => validate(cfg));
});

test("validate: rejects zero minSpread", () => {
  assert.throws(() => validate({ ...cfg, minSpread: 0 }));
});

test("validate: rejects baseSpread below minSpread", () => {
  assert.throws(() => validate({ ...cfg, baseSpread: cfg.minSpread - 1e-9 }));
});

test("validate: rejects maxSpread below baseSpread", () => {
  assert.throws(() => validate({ ...cfg, maxSpread: cfg.baseSpread - 1e-9 }));
});

test("validate: rejects an absurdly wide maxSpread (>= 1/4 of par)", () => {
  assert.throws(() => validate({ ...cfg, maxSpread: 0.25 }));
});

test("validate: rejects zero refTau", () => {
  assert.throws(() => validate({ ...cfg, refTau: 0 }));
});

test("validate: rejects maxUrgencyMult below 1", () => {
  assert.throws(() => validate({ ...cfg, maxUrgencyMult: 1 - 1e-9 }));
});

// --- urgencyMultiplier ------------------------------------------------------

test("urgencyMultiplier: is 1 at or beyond refTau", () => {
  assert.strictEqual(urgencyMultiplier(cfg, cfg.refTau), 1);
  assert.strictEqual(urgencyMultiplier(cfg, cfg.refTau * 10), 1);
});

test("urgencyMultiplier: quartering tau doubles it (sqrt(900/225) == 2)", () => {
  const mult = urgencyMultiplier(cfg, cfg.refTau / 4);
  assert.ok(Math.abs(mult - 2) < 1e-9, `mult=${mult}`);
});

test("urgencyMultiplier: capped at maxUrgencyMult near expiry", () => {
  assert.strictEqual(urgencyMultiplier(cfg, 0), cfg.maxUrgencyMult);
  assert.strictEqual(urgencyMultiplier(cfg, 1), cfg.maxUrgencyMult);
});

test("urgencyMultiplier: never below 1 nor above the cap, monotonically decreasing in tau", () => {
  const taus = [0, 1, 10, 100, 225, 500, 900, 2000, 50000, 864000];
  let prev = Infinity;
  for (const tau of taus) {
    const mult = urgencyMultiplier(cfg, tau);
    assert.ok(mult >= 1 - 1e-12, `mult=${mult} at tau=${tau}`);
    assert.ok(mult <= cfg.maxUrgencyMult + 1e-12, `mult=${mult} at tau=${tau}`);
    assert.ok(mult <= prev + 1e-12, `not monotonic at tau=${tau}: prev=${prev} mult=${mult}`);
    prev = mult;
  }
});

// --- skewPenalty ------------------------------------------------------------

test("skewPenalty: 1 + skewCoef * skewWad", () => {
  assert.strictEqual(skewPenalty(cfg, 0), 1);
  assert.ok(Math.abs(skewPenalty(cfg, 0.4) - 1.2) < 1e-12);
});

// --- quote --------------------------------------------------------------

test("quote: a balanced window charges exactly baseSpread on both legs at refTau", () => {
  const { askUp, askDown } = quote(cfg, 0.62, cfg.refTau, 0, 0);
  assert.ok(Math.abs(askUp - (0.62 + cfg.baseSpread)) < 1e-9);
  assert.ok(Math.abs(askDown - (0.38 + cfg.baseSpread)) < 1e-9);
});

test("quote: a complete set always sells for more than the 1 unit it cost to mint", () => {
  const { askUp, askDown } = quote(cfg, 0.62, cfg.refTau, 0, 0);
  assert.ok(askUp + askDown > 1);
  assert.ok(Math.abs(askUp + askDown - (1 + 2 * cfg.baseSpread)) < 1e-9);
});

test("quote: widens as expiry approaches", () => {
  const far = quote(cfg, 0.5, cfg.refTau, 0, 0);
  const near = quote(cfg, 0.5, cfg.refTau / 9, 0, 0);
  assert.ok(near.askUp > far.askUp, `near=${near.askUp} far=${far.askUp}`);
});

test("quote: charges more on the side already held (skew), and leaves the other leg alone", () => {
  const flat = quote(cfg, 0.5, cfg.refTau, 0, 0);
  const skewed = quote(cfg, 0.5, cfg.refTau, 0.4, 0);
  assert.ok(skewed.askUp > flat.askUp, `skewed=${skewed.askUp} flat=${flat.askUp}`);
  assert.ok(Math.abs(skewed.askDown - flat.askDown) < 1e-12, "downSkew=0 in both -> askDown unaffected");
});

test("quote: rejects fair value at or outside (0,1)", () => {
  assert.throws(() => quote(cfg, 0, cfg.refTau, 0, 0));
  assert.throws(() => quote(cfg, 1, cfg.refTau, 0, 0));
});

test("quote: handles fair value against the ceiling without pushing a leg to/past 1", () => {
  const { askUp, askDown } = quote(cfg, 1 - 1e-9, cfg.refTau, 0, 0);
  assert.ok(askUp < 1);
  assert.ok(askDown < 1);
  assert.ok(askUp + askDown >= 1 + 2 * cfg.minSpread - 1e-9);
});

test("quote: handles fair value against the floor without pushing a leg to/past 1", () => {
  const { askUp, askDown } = quote(cfg, 1e-9, cfg.refTau, 0, 0);
  assert.ok(askUp < 1);
  assert.ok(askDown < 1);
  assert.ok(askUp + askDown >= 1 + 2 * cfg.minSpread - 1e-9);
});

test("quote: the invariant holds across a grid of fair value / tau / skew combinations", () => {
  const fvs = [0.001, 0.1, 0.3, 0.5, 0.7, 0.9, 0.999];
  const taus = [0, 1, 100, 900, 5000, 30 * 86400];
  const skews = [0, 0.1, 1, 5, 10];
  for (const fv of fvs) {
    for (const tau of taus) {
      for (const us of skews) {
        for (const ds of skews) {
          const { askUp, askDown } = quote(cfg, fv, tau, us, ds);
          assert.ok(askUp > 0 && askUp < 1, `askUp=${askUp} out of (0,1) at fv=${fv} tau=${tau}`);
          assert.ok(askDown > 0 && askDown < 1, `askDown=${askDown} out of (0,1) at fv=${fv} tau=${tau}`);
          assert.ok(
            askUp + askDown >= 1 + 2 * cfg.minSpread - 1e-9,
            `invariant violated: askUp=${askUp} askDown=${askDown} fv=${fv} tau=${tau} us=${us} ds=${ds}`
          );
        }
      }
    }
  }
});

test("quote: total markup (sum - 1) stays within [2*minSpread, 2*maxSpread] at zero skew", () => {
  const fvs = [1e-6, 0.2, 0.5, 0.8, 1 - 1e-6];
  const taus = [0, 50, 900, 100000];
  for (const fv of fvs) {
    for (const tau of taus) {
      const { askUp, askDown } = quote(cfg, fv, tau, 0, 0);
      const totalMarkup = askUp + askDown - 1;
      assert.ok(totalMarkup >= 2 * cfg.minSpread - 1e-9, `totalMarkup=${totalMarkup}`);
      assert.ok(totalMarkup <= 2 * cfg.maxSpread + 1e-9, `totalMarkup=${totalMarkup}`);
    }
  }
});

// --- assertSolvent ----------------------------------------------------------

test("assertSolvent: throws when askUp + askDown < 1 + 2*minSpread", () => {
  assert.throws(() => assertSolvent(cfg, 0.5, 0.5)); // sum=1, invariant needs >= 1.01
});

test("assertSolvent: does not throw for a valid quote", () => {
  assert.doesNotThrow(() => assertSolvent(cfg, 0.5 + cfg.baseSpread, 0.5 + cfg.baseSpread));
});

test("DEFAULT_CONFIG matches the reference contract test config", () => {
  assert.deepStrictEqual(DEFAULT_CONFIG, cfg);
});
