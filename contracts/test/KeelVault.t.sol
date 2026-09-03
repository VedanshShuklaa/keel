// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {KeelVault} from "../src/KeelVault.sol";
import {SpreadPolicy} from "../src/lib/SpreadPolicy.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockOutcome6909} from "./mocks/MockOutcome6909.sol";
import {
    MockBinaryPool, MockBinaryMarket, MockSettlement, MockModule
} from "./mocks/MockBinaryPool.sol";

contract KeelVaultTest is Test {
    uint256 constant WAD = 1e18;
    uint256 constant ONE = 1e6; // one whole outcome token in raw collateral units
    bytes32 constant VENUE = keccak256("keel.test.venue");
    bytes32 constant MARKET_ID = bytes32(uint256(1));
    bytes32 constant MARKET_ID_2 = bytes32(uint256(2));
    uint256 constant DEAD_SHARES = 1e3;
    uint256 constant MIN_DEPOSIT = 1e3;

    MockERC20 collateral;
    MockOutcome6909 outcome;
    MockBinaryMarket market;
    MockSettlement settlement;
    MockModule module;
    MockBinaryPool pool;
    KeelVault vault;

    address owner = address(0xA11CE);
    address quoter = address(0xB0B);
    address feeTo = address(0xFEE);
    address alice = address(0xA1);
    address bob = address(0xB1);

    uint64 expiryNs;

    function setUp() public {
        vm.warp(1_700_000_000);
        expiryNs = uint64((block.timestamp + 900) * 1e9);

        collateral = new MockERC20();
        outcome = new MockOutcome6909();
        market = new MockBinaryMarket();
        settlement = new MockSettlement(collateral, outcome);
        module = new MockModule();
        pool = new MockBinaryPool(collateral, outcome, market, settlement, expiryNs);

        vm.prank(owner);
        vault = new KeelVault(
            address(collateral), address(module), VENUE, quoter, feeTo, 1000, _cfg()
        );

        // The module is the registry `registerPool` trusts. Listing the pool here is
        // the mock's stand-in for the market creator having minted it on our venue.
        module.list(MARKET_ID, address(collateral), VENUE, address(pool), pool.yesId(), pool.noId());
        module.list(MARKET_ID_2, address(collateral), VENUE, address(pool), pool.yesId(), pool.noId());

        // The counterparties bring their own money: the pool pays fills and the
        // settlement contract pays redemptions.
        collateral.mint(address(pool), 1_000_000e6);
        collateral.mint(address(settlement), 1_000_000e6);

        collateral.mint(alice, 10_000e6);
        collateral.mint(bob, 10_000e6);
        vm.prank(alice);
        collateral.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        collateral.approve(address(vault), type(uint256).max);
    }

    function _cfg() internal pure returns (SpreadPolicy.Config memory) {
        return SpreadPolicy.Config({
            baseSpread: 0.015e18,
            minSpread: 0.005e18,
            maxSpread: 0.08e18,
            refTau: 900,
            skewCoef: 0.5e18,
            maxUrgencyMult: 6e18
        });
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _depositAndRoll(address who, uint256 assets) internal {
        vm.prank(who);
        vault.requestDeposit(assets);
        vault.rollEpoch();
        vm.prank(who);
        vault.claim();
    }

    function _register() internal {
        vm.prank(quoter);
        vault.registerPool(address(pool), MARKET_ID);
    }

    function _upId() internal view returns (uint256) {
        return pool.yesId();
    }

    function _downId() internal view returns (uint256) {
        return pool.noId();
    }

    // ---------------------------------------------------------------------
    // Access control
    // ---------------------------------------------------------------------

    function test_quoterOnlyFunctionsRejectStrangers() public {
        _register();
        vm.expectRevert(KeelVault.NotQuoter.selector);
        vault.registerPool(address(pool), MARKET_ID_2);

        vm.expectRevert(KeelVault.NotQuoter.selector);
        vault.mintSets(address(pool), 1e6);

        vm.expectRevert(KeelVault.NotQuoter.selector);
        vault.quote(address(pool), 0.5e18, 1e6);

        vm.expectRevert(KeelVault.NotQuoter.selector);
        vault.cancelAll(address(pool));
    }

    function test_ownerOnlyFunctionsRejectQuoter() public {
        vm.startPrank(quoter);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.setQuoter(address(0xdead));
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.setFee(quoter, 100);
        vm.stopPrank();
    }

    /// @notice The whole point of the role split: a compromised quoter can quote
    ///         badly, but every route by which collateral leaves the vault is
    ///         either a depositor claiming their own shares or a price the policy
    ///         has already vetted.
    function test_quoterCannotMoveCollateralOut() public {
        _depositAndRoll(alice, 1000e6);
        _register();

        uint256 before = collateral.balanceOf(address(vault));
        vm.startPrank(quoter);
        vault.mintSets(address(pool), 500e6);
        vault.quote(address(pool), 0.5e18, 500e6);
        vault.cancelAll(address(pool));
        vault.burnSets(address(pool), 500e6);
        vm.stopPrank();

        assertEq(collateral.balanceOf(address(vault)), before, "round trip is value-neutral");
        assertEq(collateral.balanceOf(quoter), 0, "quoter received nothing");
    }

    function test_ownerCannotMoveCollateralOut() public {
        _depositAndRoll(alice, 1000e6);
        uint256 before = collateral.balanceOf(address(vault));

        vm.startPrank(owner);
        vault.setQuoter(owner);
        vault.setFee(owner, 2000);
        vault.setConfig(_cfg());
        vm.stopPrank();

        assertEq(collateral.balanceOf(address(vault)), before);
        assertEq(collateral.balanceOf(owner), 0);
    }

    function test_setFeeRejectsAboveCap() public {
        vm.prank(owner);
        vm.expectRevert(KeelVault.FeeTooHigh.selector);
        vault.setFee(feeTo, 2001);
    }

    function test_setConfigRejectsUnsafePolicy() public {
        SpreadPolicy.Config memory bad = _cfg();
        bad.minSpread = 0;
        vm.prank(owner);
        vm.expectRevert(SpreadPolicy.InvalidConfig.selector);
        vault.setConfig(bad);
    }

    // ---------------------------------------------------------------------
    // Epoch share maths
    // ---------------------------------------------------------------------

    function test_firstDepositStrikesAtOne() public {
        _depositAndRoll(alice, 1000e6);
        assertEq(vault.balanceOf(alice), 1000e6 * WAD / WAD);
        assertEq(vault.sharePrice(1), WAD);
    }

    /// @dev The classic ERC-4626 first-depositor attack: donate before anyone
    ///      deposits so the first share price is enormous. Here the price at zero
    ///      supply is a constant, so the donation is simply a gift.
    function test_donationBeforeFirstDepositCannotStealFromDepositor() public {
        collateral.mint(address(vault), 5000e6);

        vm.prank(alice);
        vault.requestDeposit(1000e6);
        vault.rollEpoch();
        vm.prank(alice);
        vault.claim();

        assertEq(vault.sharePrice(1), WAD, "price is fixed at zero supply");
        assertEq(vault.balanceOf(alice), 1000e6, "alice is not diluted by the donation");

        // And the donation lands in her favour at the next mark, not the attacker's:
        // 6000 collateral over 1000 shares is a price of 6, less the performance fee
        // that gain now earns.
        vault.rollEpoch();
        assertGt(vault.sharePrice(2), 5 * WAD);
        assertLt(vault.sharePrice(2), 6 * WAD);
        assertEq(vault.totalAssets(), 6000e6);
    }

    function test_pendingDepositsAreNotEquityUntilRolled() public {
        _depositAndRoll(alice, 1000e6);

        vm.prank(bob);
        vault.requestDeposit(1000e6);

        // Bob's money is in the contract but backs no shares yet, so it must not
        // inflate the price Alice would redeem at.
        assertEq(vault.totalAssets(), 1000e6);
        vault.rollEpoch();
        // Just under WAD, and only because the dead shares dilute the supply by a
        // fixed 1000 wei. Bob's queued money is still not in it.
        assertApproxEqAbs(vault.sharePrice(2), WAD, 1e12);
        assertLt(vault.sharePrice(2), WAD);
    }

    function test_redeemPaysProportionalShareOfProfit() public {
        _depositAndRoll(alice, 1000e6);
        _depositAndRoll(bob, 1000e6);

        // 10% gain arrives as collateral.
        collateral.mint(address(vault), 200e6);

        uint256 aliceShares = vault.balanceOf(alice);
        uint256 walletBefore = collateral.balanceOf(alice);
        vm.prank(alice);
        vault.requestRedeem(aliceShares);
        vault.rollEpoch();
        vm.prank(alice);
        vault.claim();

        // Half of a 2200-over-2000 pot is 1100, less the 10% performance fee that
        // the 200 of profit earns. Alice keeps the gain her capital produced.
        uint256 payout = collateral.balanceOf(alice) - walletBefore;
        assertGt(payout, 1090e6);
        assertLt(payout, 1100e6);
    }

    function test_claimBeforeRollReverts() public {
        vm.prank(alice);
        vault.requestDeposit(1000e6);
        vm.prank(alice);
        vm.expectRevert(KeelVault.NothingToClaim.selector);
        vault.claim();
    }

    function test_secondRequestSettlesTheFirst() public {
        vm.prank(alice);
        vault.requestDeposit(1000e6);
        vault.rollEpoch();

        // No explicit claim: the next request must not silently discard the first.
        vm.prank(alice);
        vault.requestDeposit(500e6);
        assertEq(vault.balanceOf(alice), 1000e6, "first deposit was settled, not lost");
    }

    /// @dev Each user's entitlement is floored independently, so the vault must
    ///      never owe out more than it minted or reserved at the roll. Amounts and
    ///      a price that divide unevenly are the case where that could break.
    function test_sumOfClaimsNeverExceedsWhatWasMinted() public {
        vm.prank(alice);
        vault.requestDeposit(333_333);
        vm.prank(bob);
        vault.requestDeposit(666_667);
        vault.rollEpoch();

        // The dead shares are part of the supply and are claimable by nobody, so
        // the bound this test states still holds — with room to spare.
        uint256 minted = vault.totalSupply();
        vm.prank(alice);
        vault.claim();
        vm.prank(bob);
        vault.claim();
        assertLe(vault.balanceOf(alice) + vault.balanceOf(bob), minted, "shares claimed");

        // Now the redemption side, at a price that does not divide evenly.
        collateral.mint(address(vault), 7);
        uint256 aShares = vault.balanceOf(alice);
        uint256 bShares = vault.balanceOf(bob);
        vm.prank(alice);
        vault.requestRedeem(aShares);
        vm.prank(bob);
        vault.requestRedeem(bShares);
        vault.rollEpoch();

        uint256 reserved = vault.reservedAssets();
        vm.prank(alice);
        vault.claim();
        vm.prank(bob);
        vault.claim();
        // Everything is added before anything is subtracted. The old ordering
        // subtracted the starting balances first, which underflows the moment the
        // pair get back even a wei less than they put in — and with dead shares in
        // the supply they always do.
        assertLe(
            collateral.balanceOf(alice) + collateral.balanceOf(bob) + 1_000_000,
            reserved + 20_000e6,
            "claims never exceed what the roll reserved"
        );
        // Every share but the dead ones, which are held at an address with no key and
        // are never redeemed by anyone.
        assertEq(vault.totalSupply(), DEAD_SHARES, "every claimable share was burned");
    }

    // ---------------------------------------------------------------------
    // Flatness gate
    // ---------------------------------------------------------------------

    function test_rollEpochRevertsWhileInventoryIsOpen() public {
        _depositAndRoll(alice, 1000e6);
        _register();
        vm.prank(quoter);
        vault.mintSets(address(pool), 500e6);

        assertFalse(vault.isFlat());
        vm.expectRevert(KeelVault.NotFlat.selector);
        vault.rollEpoch();
    }

    function test_poolRetiresOnlyWhenItHoldsNothing() public {
        _depositAndRoll(alice, 1000e6);
        _register();
        vm.startPrank(quoter);
        vault.mintSets(address(pool), 500e6);
        vault.quote(address(pool), 0.5e18, 500e6);
        assertEq(vault.activePoolCount(), 1);

        // Cancelling returns the escrow but the vault still holds the sets.
        vault.cancelAll(address(pool));
        assertEq(vault.activePoolCount(), 1, "still holding inventory");

        vault.burnSets(address(pool), 500e6);
        vm.stopPrank();
        assertEq(vault.activePoolCount(), 0, "flat");
        assertTrue(vault.isFlat());
    }

    // ---------------------------------------------------------------------
    // Quoting
    // ---------------------------------------------------------------------

    function test_quoteRestsBothLegsAbovePar() public {
        _depositAndRoll(alice, 1000e6);
        _register();
        vm.startPrank(quoter);
        vault.mintSets(address(pool), 500e6);
        vault.quote(address(pool), 0.5e18, 500e6);
        vm.stopPrank();

        uint128[] memory ids = vault.openOrders(address(pool));
        assertEq(ids.length, 2);

        (, uint8 kindUp, uint256 pxUp,,,) = pool.orders(ids[0]);
        (, uint8 kindDown, uint256 pxDownYesTerms,,,) = pool.orders(ids[1]);
        assertEq(kindUp, 1, "SELL_YES");
        assertEq(kindDown, 3, "SELL_NO");

        // The Down order is priced in Up terms; what Keel is paid is the complement.
        uint256 proceedsDown = ONE - pxDownYesTerms;
        assertGt(pxUp + proceedsDown, ONE, "selling the set returns more than it cost");
    }

    function test_quoteRejectsSizeAboveMatchedInventory() public {
        _depositAndRoll(alice, 1000e6);
        _register();
        vm.startPrank(quoter);
        vault.mintSets(address(pool), 100e6);
        vm.expectRevert(KeelVault.InsufficientInventory.selector);
        vault.quote(address(pool), 0.5e18, 200e6);
        vm.stopPrank();
    }

    /// @dev A post-only order that would cross comes back rejected inside a
    ///      successful transaction. Recording it as live would leave the vault
    ///      believing it is on a book it never joined.
    function test_rejectedOrderRevertsRatherThanBeingRecorded() public {
        _depositAndRoll(alice, 1000e6);
        _register();
        pool.setRejectPlacements(true);
        vm.startPrank(quoter);
        vault.mintSets(address(pool), 500e6);
        vm.expectRevert(KeelVault.OrderRejected.selector);
        vault.quote(address(pool), 0.5e18, 500e6);
        vm.stopPrank();
    }

    function test_mintSetsCannotSpendQueuedDepositsOrPromisedRedemptions() public {
        _depositAndRoll(alice, 1000e6);
        _register();

        vm.prank(bob);
        vault.requestDeposit(5000e6);

        vm.prank(quoter);
        vm.expectRevert(KeelVault.InsufficientInventory.selector);
        vault.mintSets(address(pool), 1001e6);

        vm.prank(quoter);
        vault.mintSets(address(pool), 1000e6);
    }

    // ---------------------------------------------------------------------
    // Full round trip
    // ---------------------------------------------------------------------

    function test_bothLegsFillingIsProfitRegardlessOfOutcome() public {
        _depositAndRoll(alice, 1000e6);
        _register();

        vm.startPrank(quoter);
        vault.mintSets(address(pool), 500e6);
        vault.quote(address(pool), 0.5e18, 500e6);
        vm.stopPrank();

        uint128[] memory ids = vault.openOrders(address(pool));
        pool.fill(ids[0], 500e6);
        pool.fill(ids[1], 500e6);

        // Nothing left to hold; only the ids need clearing.
        vm.prank(quoter);
        vault.cancelAll(address(pool));
        assertTrue(vault.isFlat());

        vault.rollEpoch();
        assertGt(vault.sharePrice(2), WAD, "markup was earned, not a directional bet");
    }

    function test_oneSidedFillLeavesTheVaultLongAndTheMarkIsConservative() public {
        _depositAndRoll(alice, 1000e6);
        _register();

        vm.startPrank(quoter);
        vault.mintSets(address(pool), 500e6);
        vault.quote(address(pool), 0.5e18, 500e6);
        vm.stopPrank();

        uint128[] memory ids = vault.openOrders(address(pool));
        pool.fill(ids[0], 500e6); // only the Up leg is taken

        vm.prank(quoter);
        vault.cancelAll(address(pool));

        // 500 Down and no Up. Matched sets are zero, so the leftover leg is carried
        // at zero rather than at a number somebody could argue with.
        assertEq(outcome.balanceOf(address(vault), _upId()), 0);
        assertEq(outcome.balanceOf(address(vault), _downId()), 500e6);
        assertEq(vault.totalAssets(), collateral.balanceOf(address(vault)));
        assertFalse(vault.isFlat(), "an unresolved leg is still exposure");
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    function test_redeemSettledPaysTheWinningLeg() public {
        _depositAndRoll(alice, 1000e6);
        _register();
        vm.startPrank(quoter);
        vault.mintSets(address(pool), 500e6);
        vault.quote(address(pool), 0.5e18, 500e6);
        vm.stopPrank();

        uint128[] memory ids = vault.openOrders(address(pool));
        pool.fill(ids[0], 500e6);
        vm.prank(quoter);
        vault.cancelAll(address(pool));

        market.resolveDown();
        settlement.setPayout(_downId(), ONE);

        uint256 before = collateral.balanceOf(address(vault));
        vault.finalize(address(pool));
        vault.redeemSettled(address(pool));

        assertEq(collateral.balanceOf(address(vault)) - before, 500e6, "winner pays par");
        assertTrue(vault.isFlat());
    }

    function test_voidedMarketRedeemsBothLegsAtHalf() public {
        _depositAndRoll(alice, 1000e6);
        _register();
        vm.prank(quoter);
        vault.mintSets(address(pool), 500e6);

        market.resolveVoid();
        settlement.setPayout(_upId(), ONE / 2);
        settlement.setPayout(_downId(), ONE / 2);

        uint256 before = collateral.balanceOf(address(vault));
        vault.redeemSettled(address(pool));
        assertEq(collateral.balanceOf(address(vault)) - before, 500e6, "half on each side");
        assertTrue(vault.isFlat());
    }

    function test_redeemBeforeResolutionReverts() public {
        _depositAndRoll(alice, 1000e6);
        _register();
        vm.expectRevert(KeelVault.NotResolved.selector);
        vault.redeemSettled(address(pool));
    }

    // ---------------------------------------------------------------------
    // Exit without the operator
    // ---------------------------------------------------------------------

    function test_reclaimExpiredRevertsWhileTheWindowIsLive() public {
        _depositAndRoll(alice, 1000e6);
        _register();
        vm.startPrank(quoter);
        vault.mintSets(address(pool), 500e6);
        vault.quote(address(pool), 0.5e18, 500e6);
        vm.stopPrank();

        vm.expectRevert(KeelVault.WindowNotExpired.selector);
        vault.reclaimExpired(address(pool));
    }

    function test_burnSetsByStrangerRevertsWhileTheWindowIsLive() public {
        _depositAndRoll(alice, 1000e6);
        _register();
        vm.prank(quoter);
        vault.mintSets(address(pool), 500e6);

        vm.prank(bob);
        vm.expectRevert(KeelVault.WindowNotExpired.selector);
        vault.burnSets(address(pool), 500e6);
    }

    /// @notice The liveness guarantee. If the quoter key goes dark mid-window, a
    ///         depositor waits out the window and drives the whole exit themselves.
    function test_depositorCanExitWithoutTheQuoter() public {
        _depositAndRoll(alice, 1000e6);
        _register();
        vm.startPrank(quoter);
        vault.mintSets(address(pool), 1000e6);
        vault.quote(address(pool), 0.5e18, 1000e6);
        vm.stopPrank();

        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestRedeem(aliceShares);

        vm.warp(block.timestamp + 901);

        // Everything from here is called by Alice, who holds no privileged key.
        vm.startPrank(alice);
        vault.reclaimExpired(address(pool));
        vault.burnSets(address(pool), 1000e6);
        assertTrue(vault.isFlat());
        vault.rollEpoch();
        vault.claim();
        vm.stopPrank();

        // All of it back but the dead shares, which are minted once and never
        // redeemed. 1000 wei out of 1000e6 — the price of closing the inflation
        // attack, paid once by the first depositor, never again.
        assertEq(collateral.balanceOf(alice), 10_000e6 - DEAD_SHARES, "whole deposit recovered but dead shares");
    }

    // ---------------------------------------------------------------------
    // The two attacks that a security review found live in an earlier version
    // ---------------------------------------------------------------------

    /// @dev The one that mattered most. `registerPool` ends in an unlimited approve
    ///      of the vault's collateral to `pool`. When the pool's own
    ///      `getBinaryPoolParams()` was the only source of truth, the quoter could
    ///      pass a contract of its own that names the real collateral, take an
    ///      infinite allowance and `transferFrom` the whole balance — bypassing every
    ///      pricing rail, because it never touches the pricing path. A stolen hot key
    ///      was a total loss, not a bad quote.
    function test_quoterCannotRegisterAPoolTheModuleDoesNotKnow() public {
        EvilPool evil = new EvilPool(address(collateral));

        vm.prank(quoter);
        vm.expectRevert(KeelVault.PoolNotInMarket.selector);
        vault.registerPool(address(evil), bytes32(uint256(0xBAD)));

        // And the allowance the attack existed to obtain was never granted.
        assertEq(collateral.allowance(address(vault), address(evil)), 0, "no allowance to a forged pool");
    }

    /// @dev Naming a real, listed market does not help either: the module answers
    ///      with the pool that market actually has, and it is not the attacker's.
    function test_forgedPoolCannotBorrowARealMarketId() public {
        EvilPool evil = new EvilPool(address(collateral));

        vm.prank(quoter);
        vm.expectRevert(KeelVault.PoolNotInMarket.selector);
        vault.registerPool(address(evil), MARKET_ID);
        assertEq(collateral.allowance(address(vault), address(evil)), 0);
    }

    /// @dev A genuine pool on somebody else's venue is still not ours to underwrite.
    function test_poolFromAnotherVenueIsRejected() public {
        bytes32 foreign = keccak256("someone.elses.venue");
        bytes32 marketId = bytes32(uint256(0xF0));
        module.list(marketId, address(collateral), foreign, address(pool), pool.yesId(), pool.noId());

        vm.prank(quoter);
        vm.expectRevert(KeelVault.PoolNotFromOurVenue.selector);
        vault.registerPool(address(pool), marketId);
    }

    /// @dev And a market settling in a different token would have the vault approve
    ///      that token and mint sets it has no way to value.
    function test_poolSettlingInAnotherTokenIsRejected() public {
        MockERC20 other = new MockERC20();
        bytes32 marketId = bytes32(uint256(0xF1));
        module.list(marketId, address(other), VENUE, address(pool), pool.yesId(), pool.noId());

        vm.prank(quoter);
        vm.expectRevert(KeelVault.WrongCollateral.selector);
        vault.registerPool(address(pool), marketId);
    }

    /// @dev The share-inflation attack, run end to end. Seed a one-wei supply, donate
    ///      a large amount straight to the contract so it lands in `nav` without ever
    ///      being a queued deposit, roll, and wait for an honest depositor whose
    ///      shares then floor to zero. Dead shares make the attacker pay for the
    ///      privilege instead of profiting from it.
    function test_shareInflationAttackLosesMoneyForTheAttacker() public {
        address attacker = address(0xBAD1);
        collateral.mint(attacker, 100_000e6);
        vm.startPrank(attacker);
        collateral.approve(address(vault), type(uint256).max);

        // Step 1: the smallest supply the vault will accept.
        vault.requestDeposit(MIN_DEPOSIT);
        // Step 2: the donation. A plain transfer, so `pendingDepositAssets` never
        // sees it and it is pure `nav` at the roll.
        collateral.transfer(address(vault), 50_000e6);
        vm.stopPrank();

        vault.rollEpoch();
        // Shares sit with the vault until claimed, so collect them before the price
        // the attack is trying to inflate gets struck.
        vm.prank(attacker);
        vault.claim();
        vault.rollEpoch(); // strike the inflated price the victim would deposit into

        uint256 victimDeposit = 1_000e6;
        vm.prank(alice);
        vault.requestDeposit(victimDeposit);
        vault.rollEpoch();
        vm.prank(alice);
        vault.claim();

        // The victim gets real shares, not zero — which is the whole attack.
        assertGt(vault.balanceOf(alice), 0, "the victim's deposit must not floor to zero shares");

        // And the attacker cannot get their donation back: the dead shares hold a
        // claim on it that nobody can ever redeem.
        vm.startPrank(attacker);
        vault.requestRedeem(vault.balanceOf(attacker));
        vm.stopPrank();
        vault.rollEpoch();
        vm.prank(attacker);
        vault.claim();

        assertLt(collateral.balanceOf(attacker), 100_000e6, "the attack must cost the attacker money");
    }

    function test_dustDepositsAreRejected() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(KeelVault.DepositTooSmall.selector, MIN_DEPOSIT));
        vault.requestDeposit(MIN_DEPOSIT - 1);
    }

    // ---------------------------------------------------------------------
    // Performance fee
    // ---------------------------------------------------------------------

    function test_feeIsChargedOnlyAboveTheHighWaterMark() public {
        _depositAndRoll(alice, 1000e6);

        collateral.mint(address(vault), 100e6); // +10%
        vault.rollEpoch();
        uint256 feeShares1 = vault.balanceOf(feeTo);
        assertGt(feeShares1, 0, "fee charged on the gain");

        // A loss, then a partial recovery that stays under the old mark.
        vm.prank(address(vault));
        collateral.transfer(address(0xdead), 150e6);
        vault.rollEpoch();
        collateral.mint(address(vault), 100e6);
        vault.rollEpoch();

        assertEq(vault.balanceOf(feeTo), feeShares1, "no fee until the mark is beaten");
    }

    function test_feeIsPaidInSharesNotCollateral() public {
        _depositAndRoll(alice, 1000e6);
        collateral.mint(address(vault), 100e6);
        vault.rollEpoch();
        assertEq(collateral.balanceOf(feeTo), 0, "fee never leaves as collateral");
        assertGt(vault.balanceOf(feeTo), 0);
    }

    // ---------------------------------------------------------------------
    // Invariant fuzzing
    // ---------------------------------------------------------------------

    /// @notice Whatever fair value the off-chain quoter supplies, and whatever the
    ///         clock says, the pair of prices the vault actually rests must return
    ///         more than the set cost to manufacture.
    function testFuzz_restedQuotesAlwaysSellTheSetAbovePar(uint256 fairValueUp, uint256 elapsed)
        public
    {
        fairValueUp = bound(fairValueUp, 1e15, WAD - 1e15);
        elapsed = bound(elapsed, 0, 899);

        _depositAndRoll(alice, 1000e6);
        _register();
        vm.prank(quoter);
        vault.mintSets(address(pool), 500e6);

        vm.warp(block.timestamp + elapsed);
        vm.prank(quoter);
        try vault.quote(address(pool), fairValueUp, 500e6) {
            uint128[] memory ids = vault.openOrders(address(pool));
            (,, uint256 pxUp,,,) = pool.orders(ids[0]);
            (,, uint256 pxDownYesTerms,,,) = pool.orders(ids[1]);
            uint256 proceeds = pxUp + (ONE - pxDownYesTerms);
            assertGt(proceeds, ONE, "a set must never be sold at or below what it cost");
        } catch {
            // Rejecting a quote it cannot price safely is the correct alternative.
        }
    }
}

/// @notice A pool that exists only to be believed. It reports the vault's real
///         collateral so that registering it would grant an allowance over real
///         money — the exact shape the review's critical finding described.
contract EvilPool {
    address public immutable claimedCollateral;

    constructor(address collateral_) {
        claimedCollateral = collateral_;
    }

    function getBinaryPoolParams()
        external
        view
        returns (address, address, address, uint256, uint256, uint256, uint256, address, uint256, uint256, uint256, uint256, address, uint64, bool)
    {
        return (claimedCollateral, address(0), address(0), 1, 2, 1e6, 0, address(0), 0, 0, 0, 0, address(0), 1, false);
    }
}
