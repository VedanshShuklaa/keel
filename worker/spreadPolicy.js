// JS mirror of contracts/src/lib/SpreadPolicy.sol -- kept in lockstep with
// that file's algebra so the backtest and the on-chain quoting policy
// cannot silently drift apart. Solidity does this in WAD (1e18) fixed-point
// integer math; this port uses plain floats scaled to [0,1] (i.e. every
// value here is that WAD value / 1e18). The formulas, branch structure and
// evaluation order match the Solidity source line-for-line; only the
// *numeric representation* differs, which is an unavoidable consequence of
// porting fixed-point-integer Solidity to floating-point JS, not a
// behavioural change. Where Solidity nudges a boundary by "1 wei" to stay
// strictly inside (0, WAD), this port uses a small EPS instead.
//
// Pure math, no I/O. See worker/test/spreadPolicy.test.js, whose reference
// values are taken directly from contracts/test/SpreadPolicy.t.sol.

const EPS = 1e-12;

// contracts/test/SpreadPolicy.t.sol's setUp() config, verbatim (WAD values
// divided by 1e18). Passed to worker/mmbacktest.js as the round-2 default.
const DEFAULT_CONFIG = {
  baseSpread: 0.015,
  minSpread: 0.005,
  maxSpread: 0.08,
  refTau: 900,
  skewCoef: 0.5,
  maxUrgencyMult: 6,
};

class InvalidConfig extends Error {}
class InvalidFairValue extends Error {}
class QuoteBelowPar extends Error {}

// SpreadPolicy.validate()
function validate(cfg) {
  if (!(cfg.minSpread > 0)) throw new InvalidConfig("minSpread must be > 0");
  if (cfg.baseSpread < cfg.minSpread) throw new InvalidConfig("baseSpread < minSpread");
  if (cfg.maxSpread < cfg.baseSpread) throw new InvalidConfig("maxSpread < baseSpread");
  // Both legs carry the spread, so 2*maxSpread must still leave both prices
  // strictly inside (0,1) even at an extreme fair value.
  if (cfg.maxSpread >= 0.25) throw new InvalidConfig("maxSpread >= 1/4 of par");
  if (!(cfg.refTau > 0)) throw new InvalidConfig("refTau must be > 0");
  if (cfg.maxUrgencyMult < 1) throw new InvalidConfig("maxUrgencyMult < 1");
}

// SpreadPolicy.urgencyMultiplier(): widen by sqrt(refTau/tau), capped.
function urgencyMultiplier(cfg, tauSeconds) {
  if (tauSeconds <= 0) return cfg.maxUrgencyMult;
  if (tauSeconds >= cfg.refTau) return 1;
  const ratio = cfg.refTau / tauSeconds; // > 1
  const mult = Math.sqrt(ratio);
  return mult > cfg.maxUrgencyMult ? cfg.maxUrgencyMult : mult;
}

// SpreadPolicy.skewPenalty()
function skewPenalty(cfg, skewWad) {
  return 1 + cfg.skewCoef * skewWad;
}

function clampSpread(cfg, spread) {
  if (spread < cfg.minSpread) return cfg.minSpread;
  if (spread > cfg.maxSpread) return cfg.maxSpread;
  return spread;
}

// SpreadPolicy.assertSolvent() -- the one hard invariant: selling both legs
// of a freshly-minted complete set must always return more than the 1 unit
// of collateral minting it cost. NOT applicable to unwinding an
// already-held leftover leg -- see worker/marketmaker.js's unwind pricing,
// which deliberately does not call this.
function assertSolvent(cfg, askUp, askDown) {
  if (askUp + askDown < 1 + 2 * cfg.minSpread) {
    throw new QuoteBelowPar(
      `askUp(${askUp}) + askDown(${askDown}) < 1 + 2*minSpread(${1 + 2 * cfg.minSpread})`
    );
  }
}

// SpreadPolicy.quote()
function quote(cfg, fairValueUp, tauSeconds, upSkewWad, downSkewWad) {
  if (!(fairValueUp > 0) || fairValueUp >= 1) {
    throw new InvalidFairValue(`fairValueUp=${fairValueUp} must be in (0,1)`);
  }

  const urgency = urgencyMultiplier(cfg, tauSeconds);
  const base = cfg.baseSpread * urgency;

  const spreadUp = clampSpread(cfg, base * skewPenalty(cfg, upSkewWad));
  const spreadDown = clampSpread(cfg, base * skewPenalty(cfg, downSkewWad));

  let askUp = fairValueUp + spreadUp;
  let askDown = 1 - fairValueUp + spreadDown;

  // A fair value close enough to the boundary would otherwise push one leg
  // to or past 1, which is not a valid probability price. Pull it back and
  // push the difference onto the other leg, which keeps the sum -- and
  // therefore the invariant -- intact. Mirrors the Solidity "+1 wei" nudge
  // with a small EPS so the pulled-back leg stays strictly below 1.
  if (askUp >= 1) {
    const excess = askUp - 1 + EPS;
    askUp -= excess;
    askDown += excess;
  }
  if (askDown >= 1) {
    const excess = askDown - 1 + EPS;
    askDown -= excess;
    askUp += excess;
  }

  assertSolvent(cfg, askUp, askDown);
  return { askUp, askDown };
}

export { DEFAULT_CONFIG, InvalidConfig, InvalidFairValue, QuoteBelowPar, validate, urgencyMultiplier, skewPenalty, quote, assertSolvent };
