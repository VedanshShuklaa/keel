// Unit tests for worker/pricer.js — pure math, no I/O, no network.
// Run with: node --test worker/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { erf, normalCdf, sigmaPerSecond, fairValue } from "../pricer.js";

// erf.js documents itself as Abramowitz & Stegun 7.1.26, |error| < 1.5e-7.
const ERF_TOL = 1.5e-7;

test("erf(0) is within the documented approximation error of the true value 0", () => {
  assert.ok(Math.abs(erf(0) - 0) < ERF_TOL, `erf(0)=${erf(0)}`);
});

test("erf(1) matches the known reference value 0.8427007929 within tolerance", () => {
  assert.ok(Math.abs(erf(1) - 0.8427007929) < ERF_TOL, `erf(1)=${erf(1)}`);
});

test("erf(-1) is the exact negation of erf(1) (odd function, sign handled explicitly)", () => {
  assert.strictEqual(erf(-1), -erf(1));
});

test("erf(2) matches the known reference value 0.995322265 within tolerance", () => {
  assert.ok(Math.abs(erf(2) - 0.995322265) < ERF_TOL, `erf(2)=${erf(2)}`);
});

test("erf saturates toward +-1 for large |x| within tolerance", () => {
  assert.ok(Math.abs(erf(5) - 1) < ERF_TOL, `erf(5)=${erf(5)}`);
  assert.ok(Math.abs(erf(-5) - -1) < ERF_TOL, `erf(-5)=${erf(-5)}`);
  assert.ok(Math.abs(erf(10) - 1) < ERF_TOL, `erf(10)=${erf(10)}`);
});

test("normalCdf(0) is ~0.5", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6, `normalCdf(0)=${normalCdf(0)}`);
});

test("normalCdf(1.96) is ~0.975 (standard normal 97.5th percentile)", () => {
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3, `normalCdf(1.96)=${normalCdf(1.96)}`);
});

test("normalCdf(-1.96) is ~0.025", () => {
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3, `normalCdf(-1.96)=${normalCdf(-1.96)}`);
});

test("normalCdf symmetry: Phi(-x) = 1 - Phi(x), up to float rounding", () => {
  // Algebraically exact (erf(-x) === -erf(x) is exact, sign is handled
  // explicitly), but 0.5*(1+erf(-x)) vs 1-0.5*(1+erf(x)) can differ by a
  // single float ULP depending on evaluation order, so compare with a
  // tight numeric tolerance rather than strictEqual.
  for (const x of [0.3, 1, 1.96, 2.5, 4]) {
    assert.ok(
      Math.abs(normalCdf(-x) - (1 - normalCdf(x))) < 1e-15,
      `x=${x} normalCdf(-x)=${normalCdf(-x)} 1-normalCdf(x)=${1 - normalCdf(x)}`
    );
  }
});

// --- sigmaPerSecond -------------------------------------------------------

test("sigmaPerSecond: known multi-segment series matches hand-computed RMS log-return", () => {
  // Segment 1: dt=2, log-return r1=0.02  -> r1^2/dt1 = 0.0002
  // Segment 2: dt=3, log-return r2=0.03  -> r2^2/dt2 = 0.0003
  // sigma = sqrt((0.0002 + 0.0003) / 2) = sqrt(0.00025)
  const p0 = 100;
  const p1 = p0 * Math.exp(0.02);
  const p2 = p1 * Math.exp(0.03);
  const ticks = [
    { t: 0, price: p0 },
    { t: 2, price: p1 },
    { t: 5, price: p2 },
  ];
  const expected = Math.sqrt(0.00025);
  const got = sigmaPerSecond(ticks);
  assert.ok(Math.abs(got - expected) < 1e-9, `got=${got} expected=${expected}`);
});

test("sigmaPerSecond: constant per-second log-return recovers that value", () => {
  const r = 0.001;
  const ticks = [];
  let p = 100;
  for (let i = 0; i < 11; i++) {
    ticks.push({ t: i, price: p });
    p *= Math.exp(r);
  }
  const got = sigmaPerSecond(ticks);
  assert.ok(Math.abs(got - r) < 1e-9, `got=${got} expected=${r}`);
});

test("sigmaPerSecond: fewer than 2 ticks returns null", () => {
  assert.strictEqual(sigmaPerSecond([]), null);
  assert.strictEqual(sigmaPerSecond([{ t: 0, price: 100 }]), null);
});

test("sigmaPerSecond: all-non-increasing timestamps returns null", () => {
  assert.strictEqual(sigmaPerSecond([{ t: 5, price: 1 }, { t: 5, price: 2 }]), null); // equal t (dt=0)
  assert.strictEqual(sigmaPerSecond([{ t: 5, price: 1 }, { t: 3, price: 2 }]), null); // reversed t (dt<0)
});

test("sigmaPerSecond: a single bad (non-increasing) pair among good ones is skipped, not fatal", () => {
  // t: 0 -> 1 (dt=1, good, r=0.01), 1 -> 1 (dt=0, skipped: the loop still
  // uses this tick's *price* as the base for the next segment, so we keep
  // it identical to the previous tick's price to isolate the next
  // segment's return), 1 -> 2 (dt=1, good, r=0.02).
  const p0 = 100;
  const p1 = p0 * Math.exp(0.01);
  const p1dup = p1; // duplicate timestamp, same price -> isolates segment 2's return
  const p2 = p1dup * Math.exp(0.02);
  const ticks = [
    { t: 0, price: p0 },
    { t: 1, price: p1 },
    { t: 1, price: p1dup },
    { t: 2, price: p2 },
  ];
  const got = sigmaPerSecond(ticks);
  assert.notStrictEqual(got, null);
  // Only the two dt=1 segments (r=0.01, r=0.02) should count.
  const expected = Math.sqrt((0.01 ** 2 + 0.02 ** 2) / 2);
  assert.ok(Math.abs(got - expected) < 1e-9, `got=${got} expected=${expected}`);
});

// --- fairValue --------------------------------------------------------

test("fairValue: tau <= 0 collapses to a hard 1/0 based on S vs K", () => {
  assert.strictEqual(fairValue(105, 100, 0, 0.001), 1);
  assert.strictEqual(fairValue(95, 100, 0, 0.001), 0);
  assert.strictEqual(fairValue(95, 100, -5, 0.001), 0); // negative tau treated same as tau=0
  assert.strictEqual(fairValue(105, 100, -5, 0.001), 1);
});

test("fairValue: S == K with positive tau and positive sigma is ~0.5 (at-the-money)", () => {
  const v = fairValue(100, 100, 3600, 0.0001);
  assert.ok(Math.abs(v - 0.5) < 1e-6, `v=${v}`);
});

test("fairValue: strictly increasing (monotonic) in S for fixed K, tau, sigma", () => {
  // Kept within a resolvable range of d = (S-K)/(sigma*S*sqrt(tau)); far
  // outside it erf saturates to exactly +-1 in float and ties would be a
  // meaningless test of floating-point underflow rather than of monotonicity.
  const K = 100, tau = 3600, sigma = 0.001;
  const xs = [85, 92, 97, 100, 103, 108, 115];
  const ys = xs.map((S) => fairValue(S, K, tau, sigma));
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i] > ys[i - 1], `fairValue not increasing at S=${xs[i]}: ${ys[i - 1]} -> ${ys[i]}`);
  }
});

test("fairValue: collapses toward 1 as tau shrinks with S > K", () => {
  const K = 100, S = 101, sigma = 0.0001;
  const taus = [3600, 600, 60, 5, 0.5];
  const ys = taus.map((tau) => fairValue(S, K, tau, sigma));
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i] >= ys[i - 1], `expected non-decreasing toward 1 as tau shrinks: ${ys}`);
  }
  assert.ok(ys[ys.length - 1] > 0.999, `expected near-certain Up at tiny tau: ${ys[ys.length - 1]}`);
});

test("fairValue: collapses toward 0 as tau shrinks with S < K", () => {
  const K = 100, S = 99, sigma = 0.0001;
  const taus = [3600, 600, 60, 5, 0.5];
  const ys = taus.map((tau) => fairValue(S, K, tau, sigma));
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i] <= ys[i - 1], `expected non-increasing toward 0 as tau shrinks: ${ys}`);
  }
  assert.ok(ys[ys.length - 1] < 0.001, `expected near-certain Down at tiny tau: ${ys[ys.length - 1]}`);
});

test("fairValue: zero-volatility (denom<=0) with S >= K returns 1, consistent with the tau<=0 convention", () => {
  assert.strictEqual(fairValue(105, 100, 3600, 0), 1);
  assert.strictEqual(fairValue(100, 100, 3600, 0), 1); // tie goes to 1, same as the tau<=0 branch
});

// --- KNOWN BUG in pricer.js -------------------------------------------
// The tau<=0 branch uses convention `S >= K ? 1 : 0` (a hard, deterministic
// settlement). The denom<=0 branch (reached when sigmaS is 0, i.e. truly
// zero volatility, with tau still positive) is supposed to be the SAME kind
// of deterministic case -- with no volatility the price literally cannot
// move again before expiry, so S < K should also resolve to a hard 0, not
// "maximum uncertainty". But the actual code reads:
//   if (denom <= 0) return S >= K ? 1 : 0.5;
// which reports 0.5 (total uncertainty) for the S < K / zero-vol case --
// which reported 0.5 (total uncertainty) for the S < K / zero-vol case -- the
// opposite of what zero volatility means. Fixed in pricer.js; this test pins
// the corrected behaviour so it cannot regress.
test("fairValue: zero volatility resolves deterministically, matching the tau<=0 convention", () => {
  assert.strictEqual(fairValue(95, 100, 3600, 0), 0);
  assert.strictEqual(fairValue(105, 100, 3600, 0), 1);
  assert.strictEqual(fairValue(100, 100, 3600, 0), 1);
});
