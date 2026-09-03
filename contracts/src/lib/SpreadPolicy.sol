// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// @title SpreadPolicy
/// @notice Turns a model fair value into the pair of ask prices Keel rests on a
///         window's book, and defines the one invariant that makes the strategy
///         safe rather than merely profitable in expectation.
///
/// @dev Keel manufactures inventory with `mintSet`: one unit of collateral buys
///      one Up position and one Down position at the same time. Those two are
///      worth exactly one unit together at settlement, no matter how the window
///      resolves. So if both legs are sold for more than one unit combined, the
///      outcome cannot touch the vault — it has been paid a markup for a service
///      rather than taking a directional bet.
///
///      That gives a hard invariant, enforced here and asserted by the fuzz
///      tests: `askUp + askDown >= WAD + 2 * minSpread`. A quote that violates it
///      is a quote that can lose money even when everything goes right, and the
///      vault rejects it — including when the off-chain quoter asks for it. The
///      quoter's key is therefore a key that can quote badly but cannot quote
///      ruinously, and cannot withdraw at all.
///
///      All values are WAD (1e18). Probabilities live in (0, WAD).
library SpreadPolicy {
    using FixedPointMathLib for uint256;

    uint256 internal constant WAD = 1e18;

    /// @notice Tunable, owner-set, and bounded at construction by the vault.
    /// @param baseSpread     Markup charged on a calm, balanced, mid-life window.
    /// @param minSpread      Floor. The invariant above is stated in terms of this.
    /// @param maxSpread      Ceiling, so a bad input cannot produce an absurd quote.
    /// @param refTau         The time-to-expiry at which `baseSpread` applies, in
    ///                       seconds. Shorter than this and the quote widens.
    /// @param skewCoef       How hard a lopsided book widens the exposed side.
    /// @param maxUrgencyMult Cap on the near-expiry widening multiplier, WAD-scaled.
    struct Config {
        uint256 baseSpread;
        uint256 minSpread;
        uint256 maxSpread;
        uint256 refTau;
        uint256 skewCoef;
        uint256 maxUrgencyMult;
    }

    error InvalidConfig();
    error InvalidFairValue();
    error QuoteBelowPar();

    /// @notice Rejects a Config that could produce an unsafe or nonsensical quote.
    /// @dev Called by the vault whenever the owner sets policy, so the invariant
    ///      cannot be disabled by misconfiguration rather than by intent.
    function validate(Config memory cfg) internal pure {
        if (cfg.minSpread == 0) revert InvalidConfig();
        if (cfg.baseSpread < cfg.minSpread) revert InvalidConfig();
        if (cfg.maxSpread < cfg.baseSpread) revert InvalidConfig();
        // Both legs carry the spread, so 2 * maxSpread must still leave both
        // prices strictly inside (0, WAD) even at an extreme fair value.
        if (cfg.maxSpread >= WAD / 4) revert InvalidConfig();
        if (cfg.refTau == 0) revert InvalidConfig();
        if (cfg.maxUrgencyMult < WAD) revert InvalidConfig();
    }

    /// @notice How much wider to quote as expiry approaches.
    /// @dev Fair value's sensitivity to spot scales with 1/sqrt(tau): the same
    ///      unchanged price gap becomes decisive as the clock runs out, which is
    ///      exactly when a stale quote is most expensive. Widening by
    ///      sqrt(refTau / tau) tracks that sensitivity directly rather than by a
    ///      hand-tuned ladder. Capped, because the limit is unbounded.
    function urgencyMultiplier(Config memory cfg, uint256 tauSeconds) internal pure returns (uint256) {
        if (tauSeconds == 0) return cfg.maxUrgencyMult;
        if (tauSeconds >= cfg.refTau) return WAD;
        uint256 ratio = cfg.refTau.mulDiv(WAD, tauSeconds); // > WAD
        uint256 mult = FixedPointMathLib.sqrtWad(ratio);
        return mult > cfg.maxUrgencyMult ? cfg.maxUrgencyMult : mult;
    }

    /// @notice Extra markup charged on the side the vault is already long.
    /// @dev Leftover single-sided inventory is the only way this strategy loses
    ///      money, so the price of adding to it rises with how much is already
    ///      held. `skewWad` is |inventory| / NAV.
    function skewPenalty(Config memory cfg, uint256 skewWad) internal pure returns (uint256) {
        return WAD + cfg.skewCoef.mulWad(skewWad);
    }

    /// @notice The pair of ask prices to rest, given a fair value and current state.
    /// @param fairValueUp  Model probability the window closes Up, in (0, WAD).
    /// @param tauSeconds   Seconds remaining until the window expires.
    /// @param upSkewWad    Long Up inventory as a fraction of NAV.
    /// @param downSkewWad  Long Down inventory as a fraction of NAV.
    /// @return askUp       Price to rest the Up leg at.
    /// @return askDown     Price to rest the Down leg at.
    function quote(
        Config memory cfg,
        uint256 fairValueUp,
        uint256 tauSeconds,
        uint256 upSkewWad,
        uint256 downSkewWad
    ) internal pure returns (uint256 askUp, uint256 askDown) {
        if (fairValueUp == 0 || fairValueUp >= WAD) revert InvalidFairValue();

        uint256 urgency = urgencyMultiplier(cfg, tauSeconds);
        uint256 base = cfg.baseSpread.mulWad(urgency);

        uint256 spreadUp = _clampSpread(cfg, base.mulWad(skewPenalty(cfg, upSkewWad)));
        uint256 spreadDown = _clampSpread(cfg, base.mulWad(skewPenalty(cfg, downSkewWad)));

        askUp = fairValueUp + spreadUp;
        askDown = (WAD - fairValueUp) + spreadDown;

        // A fair value close enough to the boundary would otherwise push one leg
        // to or past WAD, which is not a valid probability price. Pull it back
        // and push the difference onto the other leg, which keeps the sum — and
        // therefore the invariant — intact.
        if (askUp >= WAD) {
            uint256 excess = askUp - WAD + 1;
            askUp -= excess;
            askDown += excess;
        }
        if (askDown >= WAD) {
            uint256 excess = askDown - WAD + 1;
            askDown -= excess;
            askUp += excess;
        }

        assertSolvent(cfg, askUp, askDown);
    }

    /// @notice The invariant. Selling both legs must always return more than the
    ///         one unit of collateral that minting them cost.
    function assertSolvent(Config memory cfg, uint256 askUp, uint256 askDown) internal pure {
        if (askUp + askDown < WAD + 2 * cfg.minSpread) revert QuoteBelowPar();
    }

    function _clampSpread(Config memory cfg, uint256 spread) private pure returns (uint256) {
        if (spread < cfg.minSpread) return cfg.minSpread;
        if (spread > cfg.maxSpread) return cfg.maxSpread;
        return spread;
    }
}
