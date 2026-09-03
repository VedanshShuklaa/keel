// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpreadPolicy} from "../src/lib/SpreadPolicy.sol";
import {SpreadPolicyHarness} from "./harness/SpreadPolicyHarness.sol";

contract SpreadPolicyTest is Test {
    using SpreadPolicy for SpreadPolicy.Config;

    uint256 constant WAD = 1e18;

    SpreadPolicy.Config cfg;
    SpreadPolicyHarness harness;

    function setUp() public {
        harness = new SpreadPolicyHarness();
        cfg = SpreadPolicy.Config({
            baseSpread: 0.015e18, // 1.5 cents on a dollar payout
            minSpread: 0.005e18,
            maxSpread: 0.08e18,
            refTau: 900, // a fifteen-minute window is the reference
            skewCoef: 0.5e18,
            maxUrgencyMult: 6e18
        });
    }

    // --- validate -----------------------------------------------------------

    function test_validate_acceptsSaneConfig() public view {
        SpreadPolicy.validate(cfg);
    }

    function test_validate_rejectsZeroMinSpread() public {
        cfg.minSpread = 0;
        vm.expectRevert(SpreadPolicy.InvalidConfig.selector);
        harness.validate(cfg);
    }

    function test_validate_rejectsBaseBelowMin() public {
        cfg.baseSpread = cfg.minSpread - 1;
        vm.expectRevert(SpreadPolicy.InvalidConfig.selector);
        harness.validate(cfg);
    }

    function test_validate_rejectsMaxBelowBase() public {
        cfg.maxSpread = cfg.baseSpread - 1;
        vm.expectRevert(SpreadPolicy.InvalidConfig.selector);
        harness.validate(cfg);
    }

    /// A spread at or above a quarter of par could push a leg outside (0, WAD)
    /// once both legs carry it, so the config is rejected rather than the quote.
    function test_validate_rejectsAbsurdlyWideMax() public {
        cfg.maxSpread = WAD / 4;
        vm.expectRevert(SpreadPolicy.InvalidConfig.selector);
        harness.validate(cfg);
    }

    function test_validate_rejectsZeroRefTau() public {
        cfg.refTau = 0;
        vm.expectRevert(SpreadPolicy.InvalidConfig.selector);
        harness.validate(cfg);
    }

    function test_validate_rejectsUrgencyMultBelowOne() public {
        cfg.maxUrgencyMult = WAD - 1;
        vm.expectRevert(SpreadPolicy.InvalidConfig.selector);
        harness.validate(cfg);
    }

    // --- urgency ------------------------------------------------------------

    function test_urgency_isOneAtOrBeyondReference() public view {
        assertEq(SpreadPolicy.urgencyMultiplier(cfg, cfg.refTau), WAD);
        assertEq(SpreadPolicy.urgencyMultiplier(cfg, cfg.refTau * 10), WAD);
    }

    /// Quartering the time remaining doubles the sensitivity of fair value to
    /// spot, so it should double the markup: sqrt(900 / 225) == 2.
    function test_urgency_scalesAsInverseSqrtOfTau() public view {
        uint256 mult = SpreadPolicy.urgencyMultiplier(cfg, cfg.refTau / 4);
        assertApproxEqRel(mult, 2 * WAD, 1e12);
    }

    function test_urgency_isCappedNearExpiry() public view {
        assertEq(SpreadPolicy.urgencyMultiplier(cfg, 0), cfg.maxUrgencyMult);
        assertEq(SpreadPolicy.urgencyMultiplier(cfg, 1), cfg.maxUrgencyMult);
    }

    function testFuzz_urgency_neverBelowOneNorAboveCap(uint256 tau) public view {
        uint256 mult = SpreadPolicy.urgencyMultiplier(cfg, bound(tau, 0, 10 days));
        assertGe(mult, WAD);
        assertLe(mult, cfg.maxUrgencyMult);
    }

    function testFuzz_urgency_isMonotonicallyDecreasingInTau(uint256 a, uint256 b) public view {
        uint256 lo = bound(a, 1, 100_000);
        uint256 hi = bound(b, lo, 200_000);
        assertGe(SpreadPolicy.urgencyMultiplier(cfg, lo), SpreadPolicy.urgencyMultiplier(cfg, hi));
    }

    // --- quote --------------------------------------------------------------

    function test_quote_balancedWindowChargesBaseSpreadOnBothLegs() public view {
        (uint256 askUp, uint256 askDown) = SpreadPolicy.quote(cfg, 0.62e18, cfg.refTau, 0, 0);
        assertEq(askUp, 0.62e18 + cfg.baseSpread);
        assertEq(askDown, 0.38e18 + cfg.baseSpread);
    }

    /// The whole point of the complete-set trade: sell both legs and the sum is
    /// above the one unit of collateral it took to mint them.
    function test_quote_pairAlwaysSellsAboveWhatMintingCost() public view {
        (uint256 askUp, uint256 askDown) = SpreadPolicy.quote(cfg, 0.62e18, cfg.refTau, 0, 0);
        assertGt(askUp + askDown, WAD);
        assertEq(askUp + askDown, WAD + 2 * cfg.baseSpread);
    }

    function test_quote_widensAsExpiryApproaches() public view {
        (uint256 farUp,) = SpreadPolicy.quote(cfg, 0.5e18, cfg.refTau, 0, 0);
        (uint256 nearUp,) = SpreadPolicy.quote(cfg, 0.5e18, cfg.refTau / 9, 0, 0);
        assertGt(nearUp, farUp);
    }

    /// Inventory already held on one side is the only source of directional
    /// risk, so adding to it must cost the taker more.
    function test_quote_chargesMoreOnTheSideAlreadyHeld() public view {
        (uint256 flatUp,) = SpreadPolicy.quote(cfg, 0.5e18, cfg.refTau, 0, 0);
        (uint256 skewedUp,) = SpreadPolicy.quote(cfg, 0.5e18, cfg.refTau, 0.4e18, 0);
        assertGt(skewedUp, flatUp);
    }

    function test_quote_skewOnOneSideLeavesTheOtherAlone() public view {
        (, uint256 flatDown) = SpreadPolicy.quote(cfg, 0.5e18, cfg.refTau, 0, 0);
        (, uint256 skewedDown) = SpreadPolicy.quote(cfg, 0.5e18, cfg.refTau, 0.4e18, 0);
        assertEq(skewedDown, flatDown);
    }

    function test_quote_rejectsFairValueAtOrOutsideBounds() public {
        vm.expectRevert(SpreadPolicy.InvalidFairValue.selector);
        harness.quote(cfg, 0, cfg.refTau, 0, 0);

        vm.expectRevert(SpreadPolicy.InvalidFairValue.selector);
        harness.quote(cfg, WAD, cfg.refTau, 0, 0);
    }

    /// A fair value one wei from certainty would push the Up leg past par. The
    /// excess is moved onto the other leg rather than truncated, so the sum —
    /// and therefore the solvency invariant — survives.
    function test_quote_handlesFairValueAgainstTheCeiling() public view {
        (uint256 askUp, uint256 askDown) = SpreadPolicy.quote(cfg, WAD - 1, cfg.refTau, 0, 0);
        assertLt(askUp, WAD);
        assertLt(askDown, WAD);
        assertGe(askUp + askDown, WAD + 2 * cfg.minSpread);
    }

    function test_quote_handlesFairValueAgainstTheFloor() public view {
        (uint256 askUp, uint256 askDown) = SpreadPolicy.quote(cfg, 1, cfg.refTau, 0, 0);
        assertLt(askUp, WAD);
        assertLt(askDown, WAD);
        assertGe(askUp + askDown, WAD + 2 * cfg.minSpread);
    }

    // --- the invariant, under fuzzing ---------------------------------------

    /// No combination of fair value, clock and inventory may produce a quote
    /// that sells a complete set for less than it cost to mint. If this ever
    /// fails, the strategy is not risk-free on a both-sides fill and the vault
    /// should not be deployed.
    function testFuzz_quote_neverSellsASetBelowPar(
        uint256 fairValue,
        uint256 tau,
        uint256 upSkew,
        uint256 downSkew
    ) public view {
        (uint256 askUp, uint256 askDown) = SpreadPolicy.quote(
            cfg,
            bound(fairValue, 1, WAD - 1),
            bound(tau, 0, 30 days),
            bound(upSkew, 0, 10 * WAD),
            bound(downSkew, 0, 10 * WAD)
        );
        assertGe(askUp + askDown, WAD + 2 * cfg.minSpread);
    }

    /// Both legs must remain valid probability prices, strictly inside (0, 1).
    function testFuzz_quote_legsStayInsideProbabilityBounds(
        uint256 fairValue,
        uint256 tau,
        uint256 upSkew,
        uint256 downSkew
    ) public view {
        (uint256 askUp, uint256 askDown) = SpreadPolicy.quote(
            cfg,
            bound(fairValue, 1, WAD - 1),
            bound(tau, 0, 30 days),
            bound(upSkew, 0, 10 * WAD),
            bound(downSkew, 0, 10 * WAD)
        );
        assertGt(askUp, 0);
        assertLt(askUp, WAD);
        assertGt(askDown, 0);
        assertLt(askDown, WAD);
    }

    /// Total markup is bounded regardless of input, so a broken oracle reading
    /// cannot make the vault quote at a price nobody would ever take.
    ///
    /// Note this is asserted on the SUM, not per leg. Fuzzing the per-leg
    /// version found a genuine counterexample: at a fair value near a
    /// probability boundary the quote moves markup off the leg that would
    /// otherwise price above par and onto the other one, which can carry a
    /// single leg past `maxSpread`. That redistribution is deliberate and it
    /// preserves the sum, which is the quantity solvency actually depends on.
    function testFuzz_quote_totalMarkupStaysWithinConfiguredBand(uint256 fairValue, uint256 tau) public view {
        uint256 fv = bound(fairValue, 1, WAD - 1);
        (uint256 askUp, uint256 askDown) = SpreadPolicy.quote(cfg, fv, bound(tau, 0, 30 days), 0, 0);
        uint256 totalMarkup = (askUp + askDown) - WAD;
        assertGe(totalMarkup, 2 * cfg.minSpread);
        assertLe(totalMarkup, 2 * cfg.maxSpread);
    }

    /// Away from the boundaries no redistribution happens, so there the per-leg
    /// band does hold exactly.
    function testFuzz_quote_perLegSpreadIsBandedAwayFromBoundaries(uint256 fairValue, uint256 tau)
        public
        view
    {
        uint256 fv = bound(fairValue, 0.2e18, 0.8e18);
        (uint256 askUp, uint256 askDown) = SpreadPolicy.quote(cfg, fv, bound(tau, 0, 30 days), 0, 0);
        uint256 spreadUp = askUp - fv;
        uint256 spreadDown = askDown - (WAD - fv);
        assertGe(spreadUp, cfg.minSpread);
        assertLe(spreadUp, cfg.maxSpread);
        assertGe(spreadDown, cfg.minSpread);
        assertLe(spreadDown, cfg.maxSpread);
    }
}
